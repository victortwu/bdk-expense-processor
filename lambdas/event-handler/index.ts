import type { SQSHandler } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { TABLE_NAME } from './constants'
import { resolveVendor } from './vendors/resolveVendor'
import { classifyVendor } from './vendors/classifyVendor'
import { applyRules, getConfig, getVendorRule } from './rules/engine'
import { emitNotification } from './utils/emitNotification'
import { DocumentProcessedDetail, RuleResult } from './types'
import { classifyIntent } from './intent/classifyIntent'
import { decideBooking } from './intent/decideBooking'
import { BookingOutcome, IntentResult } from './intent/types'
import { bookExpense } from '../shared/booking/bookExpense'
import { getBookingDeps } from '../shared/booking/bookingDeps'
import { expenseRepo } from '../shared/expense/expenseRepo'
import { ExpenseStatus } from '../shared/expense/status'
import { ExpenseState } from '../shared/expense/types'
import { chargeKey, docKey, fallbackChargeKey, markerKey, resolveChargeKey } from '../shared/keys'
import { QboRef } from '../shared/qbo/types'
import { parseAmount } from '../shared/utils/parseAmount'
import { logger } from '../shared/utils/logger'

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))
const s3Client = new S3Client({})
const repo = expenseRepo(ddbClient, TABLE_NAME)

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      const eventBridgeEvent = JSON.parse(record.body)
      const detail = eventBridgeEvent.detail as DocumentProcessedDetail
      const { documentId, vendorName, extractedTextUri } = detail

      logger.appendKeys({ documentId, tenantId: detail.tenantId })

      // Set by the intent gate (step 6a) when the outcome is `book`: the dedup key and the
      // vendor's invoice number, both persisted on the state so manual paths agree with us.
      let bookingChargeKey: string | undefined
      let invoiceNumber: string | undefined

      // Source PDF URI for the best-effort attach (step 9a) AND for persistence
      // onto the DOC# state so MANUAL booking paths (setAccount / correct-and-
      // submit) can attach the same PDF later (BDK #7). The event-handler is the
      // only producer of this value; it never changes for a given document.
      const originalUri = detail.originalUri || deriveOriginalUri(extractedTextUri) || undefined

      // ─── 1. Idempotency Check ──────────────────────────────────────────────
      const existing = await repo.get(documentId)

      if (existing) {
        const currentStatus = existing.status
        if (currentStatus === ExpenseStatus.Submitted || currentStatus === ExpenseStatus.Skipped) {
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
      } else if (existing?.status === ExpenseStatus.PendingValidation && existing.qboVendorRef) {
        // A human just approved/adopted this vendor (approveVendor) — trust that ref rather
        // than re-resolving by name, which can loop back to new_vendor.
        qboVendorRef = existing.qboVendorRef
        logger.info('Vendor resolved', {
          path: 'approved',
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
        await saveState(
          detail,
          {
            status: ExpenseStatus.NeedsInput,
            needsInputType: 'new_vendor',
            validationErrors: [
              {
                field: 'vendorName',
                reason: `Vendor "${vendorName || 'unknown'}" not found in QBO`,
              },
            ],
          },
          existing,
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
        const { outcome, intent } = await runIntentGate({
          detail,
          extractedText,
          vendorId: qboVendorRef.value,
          documentProfile: vendorRule?.documentProfile,
        })

        invoiceNumber = intent.invoiceNumber

        if (outcome.action !== 'book') {
          const stateOverride = mapOutcomeToState(outcome)
          await saveState(detail, { ...stateOverride, qboVendorRef, invoiceNumber }, existing)
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

        // action === 'book' → the chargeKey is the dedup identity bookExpense reserves/records.
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

      // ─── 8. Persist the decision, then book ────────────────────────────────
      // The state (incl. the prebuilt qboPayload, so a later bulk Submit/Retry works) is
      // written BEFORE booking; bookExpense then moves it ready → submitted/failed.
      const ready = ruleResult.status === 'ready' && ruleResult.qboPayload
      const saved = await saveState(
        detail,
        {
          status: ruleResult.status,
          qboVendorRef,
          invoiceNumber,
          chargeKey: ready ? bookingChargeKey : undefined,
          parsedLines: ruleResult.parsedLines,
          qboPayload: ruleResult.qboPayload,
          validationErrors: ruleResult.validationErrors,
          needsInputType: ruleResult.needsInputType,
        },
        existing,
      )

      if (!saved) {
        logger.info('Record left untouched (user-skipped or already submitted)')
        continue
      }

      if (ruleResult.status === 'needs_input') {
        const notifType = ruleResult.needsInputType || 'pick_expense_account'
        logger.warn('Rule result needs_input', { needsInputType: notifType })
        await emitNotification({
          type: notifType,
          documentId,
          vendorName,
          message: ruleResult.validationErrors?.[0]?.reason || 'Human input required',
        })
      } else if (ruleResult.qboPayload) {
        const autoSubmit = vendorRule?.autoSubmit !== false
        logger.info('AutoSubmit decision', { autoSubmit, vendorName })
        if (autoSubmit) {
          await bookReady({
            detail,
            qboVendorRef,
            invoiceNumber,
            chargeKey:
              bookingChargeKey ??
              resolveChargeKey({
                vendorId: qboVendorRef.value,
                amount: parseAmount(detail.amounts?.[0]),
                documentDate: detail.documentDate || '',
              }),
            ruleResult,
            originalUri,
          })
        }
        // If autoSubmit is false, status stays 'ready' for manual submission
      }

      logger.info('Record processed', { status: ruleResult.status })
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
const runIntentGate = async (
  params: IntentGateParams,
): Promise<{ outcome: BookingOutcome; intent: IntentResult }> => {
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
        new GetCommand({ TableName: TABLE_NAME, Key: markerKey(key) }),
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

  return { outcome, intent }
}

/**
 * Map a non-`book` BookingOutcome to an ExpenseState override. These are the
 * short-circuit paths — no QBO submit happens.
 */
const mapOutcomeToState = (outcome: BookingOutcome): StateOverrides => {
  switch (outcome.action) {
    case 'skip_duplicate':
      return {
        status: ExpenseStatus.Skipped,
        failureReason: `Duplicate of QBO purchase ${outcome.existingQboPurchaseId}`,
      }
    case 'informational':
      return {
        status: ExpenseStatus.Skipped,
        failureReason: `Informational (${outcome.reason}) — no booking required`,
      }
    case 'needs_review':
      return {
        status: ExpenseStatus.NeedsInput,
        needsInputType: 'pick_expense_account',
        validationErrors: [{ field: 'intent', reason: outcome.reason }],
        failureReason: `Needs review: ${outcome.reason}`,
      }
    default:
      // `book` is handled inline (never reaches here); fail safe to review.
      return { status: ExpenseStatus.NeedsInput, needsInputType: 'pick_expense_account' }
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

type StateOverrides = Pick<ExpenseState, 'status'> & Partial<Omit<ExpenseState, 'status'>>

/** Everything about a document that comes from the event itself. */
const buildState = (
  detail: DocumentProcessedDetail,
  overrides: StateOverrides,
  existing: ExpenseState | undefined,
): ExpenseState => {
  const now = new Date().toISOString()
  return {
    ...docKey(detail.documentId),
    tenantId: detail.tenantId,
    documentId: detail.documentId,
    vendorName: detail.vendorName || 'unknown',
    vendorDisplay: detail.vendorDisplay,
    documentDate: detail.documentDate || '',
    amounts: detail.amounts || [],
    description: detail.description,
    // Persist the source PDF URI so MANUAL booking paths can attach it later (BDK #7).
    originalUri: detail.originalUri || deriveOriginalUri(detail.extractedTextUri) || undefined,
    attempts: existing?.attempts ?? 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    ...overrides,
  }
}

/** Write the pipeline-owned state; `false` when a skipped/submitted record was left untouched. */
const saveState = async (
  detail: DocumentProcessedDetail,
  overrides: StateOverrides,
  existing: ExpenseState | undefined,
): Promise<boolean> => {
  const state = buildState(detail, overrides, existing)
  if (!existing && (await repo.createIfAbsent(state))) return true
  return repo.replaceUnlessTerminal(state)
}

interface BookReadyParams {
  detail: DocumentProcessedDetail
  qboVendorRef: QboRef
  invoiceNumber?: string
  chargeKey: string
  ruleResult: RuleResult
  originalUri?: string
}

/** Book a persisted `ready` expense through the shared path and raise the matching alerts. */
const bookReady = async (p: BookReadyParams): Promise<void> => {
  const { detail, ruleResult, qboVendorRef } = p
  const { documentId } = detail
  const vendorName = detail.vendorName

  const outcome = await bookExpense(
    {
      documentId,
      status: ExpenseStatus.Ready,
      originalUri: p.originalUri,
      booked: {
        vendorRef: qboVendorRef,
        vendorName: detail.vendorName || 'unknown',
        vendorDisplay: detail.vendorDisplay,
        documentDate: detail.documentDate || '',
        invoiceNumber: p.invoiceNumber,
        chargeKey: p.chargeKey,
        amounts: detail.amounts || [],
        parsedLines: ruleResult.parsedLines ?? [],
        qboPayload: ruleResult.qboPayload!,
      },
    },
    ddbClient,
    getBookingDeps(),
  )

  switch (outcome.kind) {
    case 'submitted': {
      const { qboPurchaseId, qboDocNumber } = outcome.result
      logger.info('QBO submit outcome', { outcome: 'submitted', qboDocNumber, qboPurchaseId })
      if (outcome.result.attachmentUploaded) {
        logger.info('Attachment outcome', { outcome: 'uploaded', qboPurchaseId })
      } else if (outcome.result.attachmentFailed) {
        logger.warn('Attachment outcome', { outcome: 'failed', qboPurchaseId })
        await emitNotification({
          type: 'attachment_failed',
          documentId,
          vendorName,
          message: 'PDF attachment failed',
        })
      }
      return
    }
    case 'failed':
      logger.warn('QBO submit outcome', { outcome: 'failed', reason: outcome.result.error })
      await emitNotification({
        type: 'submission_failed',
        documentId,
        vendorName,
        message: `QBO submission failed: ${outcome.result.error}`,
      })
      return
    case 'duplicate':
      // Lost a race for the same charge: the winner records the booking, this copy is redundant.
      logger.info('Booking skipped as duplicate', {
        existingPurchaseId: outcome.existingPurchaseId,
      })
      if (outcome.existingPurchaseId) {
        await repo.transition(documentId, {
          from: [ExpenseStatus.Ready],
          to: ExpenseStatus.Skipped,
          set: { failureReason: `Duplicate of QBO purchase ${outcome.existingPurchaseId}` },
        })
      }
      return
    default:
      logger.warn('Booking not recorded', { outcome: outcome.kind })
  }
}
