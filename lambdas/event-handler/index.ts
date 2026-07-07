import type { SQSHandler } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { TABLE_NAME, QBO_SERVICE_URL } from './constants'
import { resolveVendor } from './vendors/resolveVendor'
import { classifyVendor } from './vendors/classifyVendor'
import { applyRules, getConfig, getVendorRule } from './rules/engine'
import { attachPdf } from './utils/attachPdf'
import { emitNotification } from './utils/emitNotification'
import { DocumentProcessedDetail, ExpenseState, QboRef } from './types'

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3Client = new S3Client({})

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      const eventBridgeEvent = JSON.parse(record.body)
      const detail = eventBridgeEvent.detail as DocumentProcessedDetail
      const { documentId, vendorName, extractedTextUri } = detail

      // ─── 1. Idempotency Check ──────────────────────────────────────────────
      const existing = await ddbClient.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: `DOC#${documentId}`, sk: 'state' } }),
      )

      if (existing.Item) {
        const currentStatus = existing.Item.status
        if (currentStatus === 'submitted' || currentStatus === 'skipped') {
          console.log(`Document ${documentId} already ${currentStatus}, skipping`)
          continue
        }
        // failed or needs_input → re-process below
      }

      // ─── 2. Load Config ────────────────────────────────────────────────────
      const config = await getConfig(ddbClient)

      // ─── 3. Resolve Vendor (from QBO vendor cache) ─────────────────────────
      const qboVendor = vendorName ? await resolveVendor(ddbClient, vendorName) : null

      if (!qboVendor) {
        // Unknown vendor → needs human to approve/create
        await writeState(documentId, detail, {
          status: 'needs_input',
          needsInputType: 'new_vendor',
          validationErrors: [{ field: 'vendorName', reason: `Vendor "${vendorName || 'unknown'}" not found in QBO` }],
        }, existing.Item)

        await emitNotification({
          type: 'new_vendor',
          documentId,
          vendorName: vendorName || 'unknown',
          message: `New vendor "${detail.vendorDisplay || vendorName}" needs approval`,
        })
        continue
      }

      const qboVendorRef: QboRef = { value: qboVendor.id, name: qboVendor.displayName }

      // ─── 4. Classify Vendor (multi-line or simple) ─────────────────────────
      const { isMultiLine } = await classifyVendor(vendorName)

      // ─── 5. Fetch Extracted Text (needed for multi-line) ───────────────────
      let extractedText = ''
      if (isMultiLine && extractedTextUri) {
        extractedText = await fetchExtractedText(extractedTextUri)
      }

      // ─── 6. Check for explicit vendor rule ─────────────────────────────────
      const vendorRule = vendorName ? await getVendorRule(ddbClient, vendorName) : null

      // ─── 7. Apply Rules Engine ─────────────────────────────────────────────
      const ruleResult = await applyRules({
        detail,
        extractedText,
        isMultiLine,
        qboVendorId: qboVendor.id,
        qboVendorRef,
        rule: vendorRule,
        config,
      })

      // ─── 8. Submit or Record ───────────────────────────────────────────────
      const now = new Date().toISOString()
      let status = ruleResult.status as string
      let qboDocNumber: string | undefined
      let qboPurchaseId: string | undefined
      let submittedAt: string | undefined
      let failedAt: string | undefined
      let failureReason: string | undefined
      let attachmentUploaded: boolean | undefined
      let attachmentFailed: boolean | undefined

      if (ruleResult.status === 'ready' && ruleResult.qboPayload) {
        const autoSubmit = vendorRule?.autoSubmit !== false
        if (autoSubmit) {
          const qboResult = await submitToQbo(ruleResult.qboPayload)

          if (qboResult.success) {
            status = 'submitted'
            qboDocNumber = qboResult.docNumber
            qboPurchaseId = qboResult.purchaseId
            submittedAt = now

            // ─── 9. Attach PDF (best-effort) ─────────────────────────────
            if (qboPurchaseId) {
              const originalUri = detail.originalUri || deriveOriginalUri(extractedTextUri)
              if (originalUri) {
                const attachResult = await attachPdf(qboPurchaseId, originalUri)
                if (attachResult.success) {
                  attachmentUploaded = true
                } else {
                  attachmentFailed = true
                  await emitNotification({
                    type: 'attachment_failed',
                    documentId,
                    vendorName,
                    message: `PDF attachment failed: ${attachResult.error}`,
                  })
                }
              }
            }
          } else {
            status = 'failed'
            failedAt = now
            failureReason = qboResult.error

            await emitNotification({
              type: 'submission_failed',
              documentId,
              vendorName,
              message: `QBO submission failed: ${qboResult.error}`,
            })
          }
        }
        // If autoSubmit is false, status stays 'ready' for manual submission
      } else if (ruleResult.status === 'needs_input') {
        // Emit notification for needs_input
        const notifType = ruleResult.needsInputType || 'pick_expense_account'
        await emitNotification({
          type: notifType,
          documentId,
          vendorName,
          message: ruleResult.validationErrors?.[0]?.reason || 'Human input required',
        })
      }

      // ─── 10. Write State ───────────────────────────────────────────────────
      await writeState(documentId, detail, {
        status,
        qboVendorRef,
        parsedLines: ruleResult.parsedLines,
        validationErrors: ruleResult.validationErrors,
        needsInputType: ruleResult.needsInputType,
        qboDocNumber,
        qboPurchaseId,
        submittedAt,
        failedAt,
        failureReason,
        attachmentUploaded,
        attachmentFailed,
      }, existing.Item)

    } catch (err) {
      console.error('Error processing SQS record:', err)
      throw err // Let SQS retry
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fetchExtractedText = async (uri: string): Promise<string> => {
  const { bucket, key } = parseS3Uri(uri)
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  return (await response.Body?.transformToString()) || ''
}

const parseS3Uri = (uri: string): { bucket: string; key: string } => {
  const withoutProtocol = uri.replace('s3://', '')
  const slashIndex = withoutProtocol.indexOf('/')
  return {
    bucket: withoutProtocol.slice(0, slashIndex),
    key: withoutProtocol.slice(slashIndex + 1),
  }
}

const deriveOriginalUri = (extractedTextUri: string): string | null => {
  if (!extractedTextUri) return null
  // Replace extracted.txt with original.pdf (convention from Parsely)
  return extractedTextUri.replace('/extracted.txt', '/original.pdf')
}

const submitToQbo = async (
  qboPayload: unknown,
): Promise<{ success: boolean; docNumber?: string; purchaseId?: string; error?: string }> => {
  try {
    const response = await fetch(`${QBO_SERVICE_URL}/purchases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(qboPayload),
    })

    // 409 = duplicate — treat as success
    if (response.status === 409) {
      const data = (await response.json()) as { existing?: { id?: string; docNumber?: string } }
      return { success: true, docNumber: data.existing?.docNumber, purchaseId: data.existing?.id }
    }

    if (!response.ok) {
      const errorBody = await response.text()
      return { success: false, error: `QBO API error ${response.status}: ${errorBody}` }
    }

    const data = (await response.json()) as { id?: string; docNumber?: string }
    return { success: true, docNumber: data.docNumber, purchaseId: data.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}

interface StateOverrides {
  status: string
  qboVendorRef?: QboRef
  parsedLines?: unknown[]
  validationErrors?: unknown[]
  needsInputType?: string
  qboDocNumber?: string
  qboPurchaseId?: string
  submittedAt?: string
  failedAt?: string
  failureReason?: string
  attachmentUploaded?: boolean
  attachmentFailed?: boolean
}

const writeState = async (
  documentId: string,
  detail: DocumentProcessedDetail,
  overrides: StateOverrides,
  existingItem: Record<string, unknown> | undefined,
): Promise<void> => {
  const now = new Date().toISOString()
  const isReprocess = !!existingItem
  const attempts = isReprocess
    ? ((existingItem?.attempts as number) || 0) + (overrides.status === 'submitted' || overrides.status === 'failed' ? 1 : 0)
    : overrides.status === 'submitted' || overrides.status === 'failed' ? 1 : 0

  const state: ExpenseState = {
    pk: `DOC#${documentId}`,
    sk: 'state',
    tenantId: detail.tenantId,
    documentId,
    status: overrides.status,
    vendorName: detail.vendorName || 'unknown',
    vendorDisplay: detail.vendorDisplay,
    documentDate: detail.documentDate || '',
    amounts: detail.amounts || [],
    description: detail.description,
    parsedLines: overrides.parsedLines as ExpenseState['parsedLines'],
    validationErrors: overrides.validationErrors as ExpenseState['validationErrors'],
    needsInputType: overrides.needsInputType as ExpenseState['needsInputType'],
    qboDocNumber: overrides.qboDocNumber,
    qboPurchaseId: overrides.qboPurchaseId,
    qboVendorRef: overrides.qboVendorRef,
    attachmentUploaded: overrides.attachmentUploaded,
    attachmentFailed: overrides.attachmentFailed,
    submittedAt: overrides.submittedAt,
    failedAt: overrides.failedAt,
    failureReason: overrides.failureReason,
    lastAttempt: overrides.status === 'submitted' || overrides.status === 'failed' ? now : undefined,
    attempts,
    createdAt: (existingItem?.createdAt as string) || now,
    updatedAt: now,
  }

  await ddbClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: state,
      // Idempotency: don't overwrite if someone skipped it
      ConditionExpression: 'attribute_not_exists(pk) OR #status <> :skipped',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':skipped': 'skipped' },
    }),
  ).catch((err) => {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log(`Document ${documentId} was skipped by user, not overwriting`)
    } else {
      throw err
    }
  })
}
