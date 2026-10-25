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
import { classifyIntent } from './intent/classifyIntent'
import { decideBooking, chargeKey, fallbackChargeKey } from './intent/decideBooking'
import { BookingOutcome, IntentResult } from './intent/types'
import { submitCharge } from '../shared/booking/submitCharge'
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

      // Set by the intent gate (step 6a) when the outcome is `book`; consumed at
      // step 9a to write the dedup CHARGE# marker after a successful submit.
      let bookingChargeKey: string | undefined

      // Source PDF URI for the best-effort attach (step 9a) AND for persistence
      // onto the DOC# state so MANUAL booking paths (setAccount / correct-and-
      // submit) can attach the same PDF later (BDK #7). The event-handler is the
      // only producer of this value; it never changes for a given document.
      const originalUri = detail.originalUri || deriveOriginalUri(extractedTextUri) || undefined

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

      // ─── 6. Fetch Extracted Text ───────────────────────────────────────────
      // Needed by catalog_reconcile AND by the Stage-2 intent classifier (which
      // runs for every financial doc). Fetch once up front; reuse below.
      const needsText =
        isMultiLine ||
        vendorRule?.ruleType === 'catalog_reconcile' ||
        detail.documentType === 'financial'
      let extractedText = ''
      if (needsText && extractedTextUri) {
        extractedText = await fetchExtractedText(extractedTextUri)
      }

      // ─── 6a. INTENT GATE (Stage 2 + Stage 3) ───────────────────────────────
      // Accrual booking decision for FINANCIAL documents only. Defensive gate:
      // the EventBridge rule already restricts to documentType==='financial', but
      // fail safe. If the intent layer resolves to anything other than `book`, we
      // short-circuit BEFORE applyRules/submit and record a non-booking state.
      if (detail.documentType === 'financial') {
        const outcome = await runIntentGate({
          detail,
          extractedText,
          vendorId: qboVendorRef.value,
          documentProfile: vendorRule?.documentProfile,
        })

        if (outcome.action !== 'book') {
          const stateOverride = mapOutcomeToState(outcome)
          await writeState(documentId, detail, { ...stateOverride, qboVendorRef }, existing.Item)
          // Only alert a human when the outcome genuinely needs review. A
          // skip_duplicate / informational outcome is a correct auto-decision —
          // the structured 'Intent decision' log already covers observability,
          // so emitting a "pick an account" alert for it would just be noise.
          if (outcome.action === 'needs_review') {
            await emitNotification({
              type: 'pick_expense_account',
              documentId,
              vendorName: vendorName || 'unknown',
              message: stateOverride.failureReason || `Needs review: ${outcome.reason}`,
            })
          }
          logger.info('Record processed', { status: stateOverride.status })
          continue
        }

        // action === 'book' → remember the chargeKey so we can write the dedup
        // marker after a successful QBO submit (step 9a).
        bookingChargeKey = outcome.chargeKey
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
          const qboResult = await submitCharge(
            {
              qboPayload: ruleResult.qboPayload,
              documentId,
              // Preserve the former derivation EXACTLY: the invoice number is the
              // segment after #INV# in the primary charge key (undefined for a
              // fallback key) so the marker item shape stays byte-identical.
              chargeKey: bookingChargeKey,
              vendorId: qboVendorRef.value,
              invoiceNumber: bookingChargeKey?.split('#INV#')[1],
              amount: parseAmount(detail.amounts?.[0] ?? 0),
              documentDate: detail.documentDate || '',
              originalUri,
            },
            ddbClient,
            {
              getAuthToken,
              qboServiceUrl: QBO_SERVICE_URL,
              tableName: TABLE_NAME,
              attachPdf,
            },
          )

          if (qboResult.success) {
            status = 'submitted'
            qboDocNumber = qboResult.qboDocNumber
            qboPurchaseId = qboResult.qboPurchaseId
            submittedAt = now
            logger.info('QBO submit outcome', { outcome: 'submitted', qboDocNumber, qboPurchaseId })

            if (qboResult.attachmentUploaded) {
              attachmentUploaded = true
              logger.info('Attachment outcome', { outcome: 'uploaded', qboPurchaseId })
            } else if (qboResult.attachmentFailed) {
              attachmentFailed = true
              logger.warn('Attachment outcome', { outcome: 'failed', qboPurchaseId })
              await emitNotification({
                type: 'attachment_failed',
                documentId,
                vendorName,
                message: 'PDF attachment failed',
              })
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

/** Parse a dollar-formatted string (or number) into a numeric amount. */
const parseAmount = (raw: string | number | undefined): number => {
  if (raw === undefined) return 0
  if (typeof raw === 'number') return raw
  const parsed = parseFloat(raw.replace(/[$,]/g, ''))
  return isNaN(parsed) ? 0 : parsed
}

interface IntentGateParams {
  detail: DocumentProcessedDetail
  extractedText: string
  vendorId: string
  documentProfile?: string
}

/**
 * Stage 2 (classifyIntent, advisory LLM) + Stage 3 (decideBooking, pure).
 * The dedup READS are done up front here (async) and handed to decideBooking as
 * an in-memory Map lookup so decideBooking stays pure/sync. Candidate charge keys
 * = the primary CHARGE#{vendorId}#INV#{invoiceNumber}, every referenced-invoice
 * key (receipts), and the amount+date fallback key.
 */
const runIntentGate = async (params: IntentGateParams): Promise<BookingOutcome> => {
  const { detail, extractedText, vendorId, documentProfile } = params
  const amount = parseAmount(detail.amounts?.[0])
  const documentDate = detail.documentDate || ''

  // Stage 2 — advisory lifecycle classification. Guard missing text (fail safe:
  // empty text → unknown/low → Stage 3 routes to needs_review).
  const intent: IntentResult = extractedText
    ? await classifyIntent(extractedText, documentProfile)
    : {
        financialIntent: 'unknown',
        referencedInvoiceNumbers: [],
        intentConfidence: 'low',
        intentRationale: 'missing_extracted_text',
      }

  // Dedup READS up front. Compute every candidate key, GetItem each, build a Map.
  const candidateKeys = new Set<string>()
  if (intent.invoiceNumber) candidateKeys.add(chargeKey(vendorId, intent.invoiceNumber))
  for (const ref of intent.referencedInvoiceNumbers) candidateKeys.add(chargeKey(vendorId, ref))
  candidateKeys.add(fallbackChargeKey(vendorId, amount, documentDate))

  const markerMap = new Map<string, { qboPurchaseId: string }>()
  await Promise.all(
    [...candidateKeys].map(async (key) => {
      const res = await ddbClient.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: key, sk: 'marker' } }),
      )
      if (res.Item?.qboPurchaseId) {
        markerMap.set(key, { qboPurchaseId: String(res.Item.qboPurchaseId) })
      }
    }),
  )

  // Stage 3 — deterministic, pure. SOLE QBO authority.
  const outcome = decideBooking({
    intent: intent.financialIntent,
    intentConfidence: intent.intentConfidence,
    vendorId,
    invoiceNumber: intent.invoiceNumber,
    referencedInvoiceNumbers: intent.referencedInvoiceNumbers,
    amount,
    documentDate,
    lookupCharge: (k) => markerMap.get(k),
    confidenceFloor: 'medium',
  })

  // Decision-point log (steering Logging convention). NEVER log document contents.
  logger.info('Intent decision', {
    intent: intent.financialIntent,
    confidence: intent.intentConfidence,
    action: outcome.action,
    reason: 'reason' in outcome ? outcome.reason : undefined,
    invoiceNumber: intent.invoiceNumber,
    referencedCount: intent.referencedInvoiceNumbers.length,
  })

  return outcome
}

/**
 * Map a non-`book` BookingOutcome to an ExpenseState override. These are the
 * short-circuit paths — no QBO submit happens.
 */
const mapOutcomeToState = (outcome: BookingOutcome): StateOverrides => {
  switch (outcome.action) {
    case 'skip_duplicate':
      return {
        status: 'skipped',
        needsInputType: undefined,
        failureReason: `Duplicate of QBO purchase ${outcome.existingQboPurchaseId}`,
      }
    case 'informational':
      return {
        status: 'skipped',
        failureReason: `Informational (${outcome.reason}) — no booking required`,
      }
    case 'needs_review':
      return {
        status: 'needs_input',
        needsInputType: 'pick_expense_account',
        validationErrors: [{ field: 'intent', reason: outcome.reason }],
        failureReason: `Needs review: ${outcome.reason}`,
      }
    default:
      // `book` is handled inline (never reaches here); fail safe to review.
      return { status: 'needs_input', needsInputType: 'pick_expense_account' }
  }
}

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
    // Persist the source PDF URI so MANUAL booking paths can attach it later (BDK #7).
    originalUri: detail.originalUri || deriveOriginalUri(detail.extractedTextUri) || undefined,
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
