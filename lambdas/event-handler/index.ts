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
import { getAuthToken } from './utils/getAuthToken'
import { DocumentProcessedDetail, ExpenseState, QboRef } from './types'
import { logger } from '../shared/utils/logger'

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3Client = new S3Client({})

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      const eventBridgeEvent = JSON.parse(record.body)
      const detail = eventBridgeEvent.detail as DocumentProcessedDetail
      const { documentId, vendorName, extractedTextUri } = detail

      logger.appendKeys({ documentId, tenantId: detail.tenantId })

      // ─── 1. Idempotency Check ──────────────────────────────────────────────
      const existing = await ddbClient.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: `DOC#${documentId}`, sk: 'state' } }),
      )

      if (existing.Item) {
        const currentStatus = existing.Item.status
        if (currentStatus === 'submitted' || currentStatus === 'skipped') {
          logger.info('Idempotency skip', { currentStatus })
          continue
        }
        // failed or needs_input → re-process below
        logger.info('Reprocessing prior record', { currentStatus })
      }

      // ─── 2. Load Config ────────────────────────────────────────────────────
      const config = await getConfig(ddbClient)

      // ─── 3. Check for explicit vendor rule ─────────────────────────────────
      const vendorRule = vendorName ? await getVendorRule(ddbClient, vendorName) : null

      // ─── 4. Resolve Vendor (rule's qboVendorRef takes priority over cache) ─
      let qboVendorRef: QboRef | null = null

      if (vendorRule?.qboVendorRef) {
        // Deterministic: rule explicitly maps to a QBO vendor
        qboVendorRef = vendorRule.qboVendorRef
        logger.info('Vendor resolved', {
          path: 'deterministic',
          vendorName,
          qboVendorName: qboVendorRef.name,
        })
      } else {
        // Fuzzy: search QBO vendor cache
        const qboVendor = vendorName ? await resolveVendor(ddbClient, vendorName) : null
        if (qboVendor) {
          qboVendorRef = { value: qboVendor.id, name: qboVendor.displayName }
          logger.info('Vendor resolved', {
            path: 'fuzzy',
            vendorName,
            qboVendorName: qboVendorRef.name,
          })
        }
      }

      if (!qboVendorRef) {
        // Unknown vendor → needs human to approve/create.
        // Log the EXTRACTED values alongside the miss so the log alone answers
        // "did extraction look right, but the vendor just isn't in QBO?" — the
        // common case for simple date+vendor+amount vendors (e.g. Costco gas)
        // that rely on an existing QBO vendor profile.
        logger.warn('Vendor not found → needs_input', {
          path: 'not_found',
          vendorName: vendorName || 'unknown',
          extractedAmount: detail.amounts?.[0],
          extractedDate: detail.documentDate,
          extractedSubType: detail.subType,
        })
        await writeState(
          documentId,
          detail,
          {
            status: 'needs_input',
            needsInputType: 'new_vendor',
            validationErrors: [
              {
                field: 'vendorName',
                reason: `Vendor "${vendorName || 'unknown'}" not found in QBO`,
              },
            ],
          },
          existing.Item,
        )

        await emitNotification({
          type: 'new_vendor',
          documentId,
          vendorName: vendorName || 'unknown',
          message: `New vendor "${detail.vendorDisplay || vendorName}" needs approval`,
        })
        continue
      }

      // ─── 5. Classify Vendor (multi-line or simple) ─────────────────────────
      const { isMultiLine } = classifyVendor(vendorName)
      logger.info('Classification path', { classification: isMultiLine ? 'multi_line' : 'simple' })

      // ─── 6. Fetch Extracted Text (needed for catalog_reconcile) ────────────
      const needsText = isMultiLine || vendorRule?.ruleType === 'catalog_reconcile'
      let extractedText = ''
      if (needsText && extractedTextUri) {
        extractedText = await fetchExtractedText(extractedTextUri)
      }

      // ─── 7. Apply Rules Engine ─────────────────────────────────────────────
      const ruleResult = await applyRules({
        detail,
        extractedText,
        isMultiLine,
        qboVendorId: qboVendorRef.value,
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
        logger.info('AutoSubmit decision', { autoSubmit, vendorName })
        if (autoSubmit) {
          const qboResult = await submitToQbo(ruleResult.qboPayload)

          if (qboResult.success) {
            status = 'submitted'
            qboDocNumber = qboResult.docNumber
            qboPurchaseId = qboResult.purchaseId
            submittedAt = now
            logger.info('QBO submit outcome', { outcome: 'submitted', qboDocNumber, qboPurchaseId })

            // ─── 9. Attach PDF (best-effort) ─────────────────────────────
            if (qboPurchaseId) {
              const originalUri = detail.originalUri || deriveOriginalUri(extractedTextUri)
              if (originalUri) {
                const attachResult = await attachPdf(qboPurchaseId, originalUri)
                if (attachResult.success) {
                  attachmentUploaded = true
                  logger.info('Attachment outcome', { outcome: 'uploaded', qboPurchaseId })
                } else {
                  attachmentFailed = true
                  logger.warn('Attachment outcome', {
                    outcome: 'failed',
                    qboPurchaseId,
                    reason: attachResult.error,
                  })
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
            logger.warn('QBO submit outcome', { outcome: 'failed', reason: qboResult.error })

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
        logger.warn('Rule result needs_input', { needsInputType: notifType })
        await emitNotification({
          type: notifType,
          documentId,
          vendorName,
          message: ruleResult.validationErrors?.[0]?.reason || 'Human input required',
        })
      }

      // ─── 10. Write State ───────────────────────────────────────────────────
      await writeState(
        documentId,
        detail,
        {
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
        },
        existing.Item,
      )

      logger.info('Record processed', { status })
    } catch (err) {
      const error = err as Error
      logger.error('Expense record processing failed', {
        errorName: error.name,
        errorMessage: error.message,
      })
      throw err // Let SQS retry
    } finally {
      logger.removeKeys(['documentId', 'tenantId'])
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
    const token = await getAuthToken()
    const response = await fetch(`${QBO_SERVICE_URL}/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(qboPayload),
    })

    // 409 = duplicate — treat as success
    if (response.status === 409) {
      const data = (await response.json()) as { existing?: { id?: string; docNumber?: string } }
      return { success: true, docNumber: data.existing?.docNumber, purchaseId: data.existing?.id }
    }

    if (!response.ok) {
      const errorBody = await response.text()
      logger.error('QBO submission failed', {
        errorClass: 'qbo_api',
        httpStatus: response.status,
        errorName: 'QboApiError',
        errorMessage: `QBO API error ${response.status}`,
      })
      return { success: false, error: `QBO API error ${response.status}: ${errorBody}` }
    }

    const data = (await response.json()) as { id?: string; docNumber?: string }
    return { success: true, docNumber: data.docNumber, purchaseId: data.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error('QBO submission error', {
      errorClass: 'qbo_api',
      errorName: err instanceof Error ? err.name : 'Error',
      errorMessage: message,
    })
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
    ? ((existingItem?.attempts as number) || 0) +
      (overrides.status === 'submitted' || overrides.status === 'failed' ? 1 : 0)
    : overrides.status === 'submitted' || overrides.status === 'failed'
      ? 1
      : 0

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
    lastAttempt:
      overrides.status === 'submitted' || overrides.status === 'failed' ? now : undefined,
    attempts,
    createdAt: (existingItem?.createdAt as string) || now,
    updatedAt: now,
  }

  await ddbClient
    .send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: state,
        // Idempotency: don't overwrite if someone skipped it
        ConditionExpression: 'attribute_not_exists(pk) OR #status <> :skipped',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':skipped': 'skipped' },
      }),
    )
    .catch((err) => {
      if (err.name === 'ConditionalCheckFailedException') {
        logger.info('State not overwritten (user-skipped)', { documentId })
      } else {
        throw err
      }
    })
}
