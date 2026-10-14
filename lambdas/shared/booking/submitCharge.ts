/**
 * SHARED BOOKING PRIMITIVE — `submitCharge`
 * ────────────────────────────────────────────────────────────────────────────
 * The single code path that books a charge to QuickBooks Online. EVERY booking
 * path — the automated SQS event-handler AND the human-initiated API handlers
 * (setAccount / submitExpenses / retryExpenses) — routes through this module so
 * that:
 *
 *   1. There is exactly ONE place that POSTs to QBO `/purchases`.
 *   2. There is exactly ONE place that writes the `CHARGE#` dedup marker.
 *   3. There is exactly ONE place that best-effort attaches the source PDF.
 *
 * This closes the live double-book hole (BDK #2): previously only the
 * event-handler wrote the dedup marker, so a manual submit created a QBO
 * purchase the dedup ledger never recorded → a later reprocess could double-book.
 *
 * SCOPE — this is a pure booking primitive. It does NOT:
 *   - write the `DOC#.../state` record (callers own their own state shape), or
 *   - emit human notifications (callers own that).
 * It returns a normalized {@link SubmitChargeResult}; callers map that result to
 * their SQS state write / API HTTP response.
 *
 * `chargeKey` is an INPUT (not computed here) so the module stays agnostic to how
 * the key is derived (primary invoice key vs amount+date fallback — the caller's
 * Stage-3 concern). A marker is written IFF both `chargeKey` AND a resolved
 * `qboPurchaseId` are present.
 */
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { logger } from '../utils/logger'

/** QBO purchase POST result (shared success-shape across 2xx and 409). */
interface QboSubmitResult {
  success: boolean
  docNumber?: string
  purchaseId?: string
  error?: string
  intuitTid?: string
}

export interface SubmitChargeInput {
  /** The QBO purchase payload (built by the caller). */
  qboPayload: unknown
  /** Document id — used for logging + marker provenance. */
  documentId: string

  // ─── Dedup context (optional — when `chargeKey` is absent, no marker) ──────
  /** CHARGE#{vendorId}#INV#{n} (or the amount+date fallback). Caller computes. */
  chargeKey?: string
  vendorId?: string
  invoiceNumber?: string
  amount?: number
  documentDate?: string

  // ─── Attachment context (optional — best-effort) ──────────────────────────
  /** When present, the source PDF is attached best-effort after booking. */
  originalUri?: string
}

export interface SubmitChargeResult {
  success: boolean
  status: 'submitted' | 'failed'
  qboPurchaseId?: string
  qboDocNumber?: string
  attachmentUploaded?: boolean
  attachmentFailed?: boolean
  error?: string
  /** `intuit_tid` captured from a QBO error response for triage. */
  intuitTid?: string
}

/**
 * Injected dependencies. Defaults are wired by the caller's own Lambda (each
 * Lambda keeps its own container-cached `getAuthToken`; only the event-handler
 * supplies an `attachPdf`). Keeping these injected keeps the module free of
 * handler-specific imports and makes it unit-testable without network.
 */
export interface SubmitChargeDeps {
  /** Returns a valid Bearer token for the QBO Service. */
  getAuthToken: () => Promise<string>
  /** The QBO Service base URL (e.g. https://qbo-service.test). */
  qboServiceUrl: string
  /** DynamoDB table name for the dedup marker write. */
  tableName: string
  /** Best-effort PDF attach. Omitted by callers that cannot fetch the PDF. */
  attachPdf?: (purchaseId: string, originalUri: string) => Promise<{ success: boolean; error?: string }>
  /** Injectable fetch (defaults to the global). */
  fetchImpl?: typeof fetch
}

/**
 * Book a charge to QBO, record the dedup marker, and (optionally) attach the PDF.
 * Never throws for an expected booking failure — returns a normalized result.
 */
export const submitCharge = async (
  input: SubmitChargeInput,
  ddb: DynamoDBDocumentClient,
  deps: SubmitChargeDeps,
): Promise<SubmitChargeResult> => {
  const { documentId } = input

  // ─── 1-4. POST to QBO (+ 409-as-success + non-2xx capture) ─────────────────
  const qbo = await submitToQbo(input.qboPayload, deps)

  if (!qbo.success) {
    logger.warn('submitCharge: QBO booking failed', {
      documentId,
      error: qbo.error,
      intuitTid: qbo.intuitTid,
    })
    return {
      success: false,
      status: 'failed',
      error: qbo.error,
      intuitTid: qbo.intuitTid,
    }
  }

  const qboPurchaseId = qbo.purchaseId
  const qboDocNumber = qbo.docNumber
  logger.info('submitCharge: QBO booking succeeded', {
    documentId,
    qboPurchaseId,
    qboDocNumber,
  })

  const result: SubmitChargeResult = {
    success: true,
    status: 'submitted',
    qboPurchaseId,
    qboDocNumber,
  }

  // ─── 5. Write dedup CHARGE# marker (conditional) ───────────────────────────
  // Marker is written IFF both a chargeKey and a resolved purchase id are present.
  if (input.chargeKey && qboPurchaseId) {
    await writeChargeMarker(
      {
        chargeKey: input.chargeKey,
        qboPurchaseId,
        documentId,
        vendorId: input.vendorId ?? '',
        invoiceNumber: input.invoiceNumber,
        amount: input.amount ?? 0,
        documentDate: input.documentDate ?? '',
        bookedAt: new Date().toISOString(),
      },
      ddb,
      deps.tableName,
    )
  }

  // ─── 6. Best-effort PDF attach ─────────────────────────────────────────────
  if (input.originalUri && qboPurchaseId && deps.attachPdf) {
    const attach = await deps.attachPdf(qboPurchaseId, input.originalUri)
    if (attach.success) {
      result.attachmentUploaded = true
      logger.info('submitCharge: attachment uploaded', { documentId, qboPurchaseId })
    } else {
      result.attachmentFailed = true
      logger.warn('submitCharge: attachment failed (booking intact)', {
        documentId,
        qboPurchaseId,
        reason: attach.error,
      })
    }
  }

  return result
}

// ─── Internal: QBO POST ───────────────────────────────────────────────────────

const submitToQbo = async (
  qboPayload: unknown,
  deps: SubmitChargeDeps,
): Promise<QboSubmitResult> => {
  const doFetch = deps.fetchImpl ?? fetch
  try {
    const token = await deps.getAuthToken()
    const response = await doFetch(`${deps.qboServiceUrl}/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(qboPayload),
    })

    // 409 = duplicate → treat as success, surfacing the existing purchase.
    if (response.status === 409) {
      const data = (await response.json()) as {
        existing?: { id?: string; docNumber?: string }
        id?: string
        docNumber?: string
      }
      return {
        success: true,
        docNumber: data.existing?.docNumber ?? data.docNumber,
        purchaseId: data.existing?.id ?? data.id,
      }
    }

    if (!response.ok) {
      const errorBody = await response.text()
      const intuitTid = extractIntuitTid(response)
      logger.error('QBO submission failed', {
        errorClass: 'qbo_api',
        httpStatus: response.status,
        errorName: 'QboApiError',
        errorMessage: `QBO API error ${response.status}`,
        intuitTid,
      })
      return {
        success: false,
        error: `QBO API error ${response.status}: ${errorBody}`,
        intuitTid,
      }
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

/** Pull the `intuit_tid` triage id from the QBO error response headers (if any). */
const extractIntuitTid = (response: { headers?: { get?: (k: string) => string | null } }): string | undefined => {
  const tid = response.headers?.get?.('intuit_tid') ?? undefined
  return tid ?? undefined
}

// ─── Internal: dedup marker ─────────────────────────────────────────────────

interface ChargeMarkerInput {
  chargeKey: string
  qboPurchaseId: string
  documentId: string
  vendorId: string
  invoiceNumber?: string
  amount: number
  documentDate: string
  bookedAt: string
}

/**
 * Write the dedup CHARGE# marker item (pk=chargeKey, sk='marker'). Conditional
 * put so a re-book never clobbers an existing marker. Item shape is byte-identical
 * to the former event-handler `writeChargeMarker` so existing dedup reads are
 * unaffected.
 */
const writeChargeMarker = async (
  m: ChargeMarkerInput,
  ddb: DynamoDBDocumentClient,
  tableName: string,
): Promise<void> => {
  await ddb
    .send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: m.chargeKey,
          sk: 'marker',
          qboPurchaseId: m.qboPurchaseId,
          documentId: m.documentId,
          vendorId: m.vendorId,
          invoiceNumber: m.invoiceNumber,
          amount: m.amount,
          documentDate: m.documentDate,
          bookedAt: m.bookedAt,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    )
    .catch((err) => {
      if (err.name === 'ConditionalCheckFailedException') {
        logger.info('Charge marker already exists (not overwritten)', { chargeKey: m.chargeKey })
      } else {
        throw err
      }
    })
}
