/**
 * SHARED BOOKING PRIMITIVE — `submitCharge`
 * ────────────────────────────────────────────────────────────────────────────
 * The single code path that POSTs a charge to QuickBooks Online, reserves and records the
 * `CHARGE#` dedup marker, and best-effort attaches the source PDF. Callers should normally
 * go through `bookExpense` (which adds the status guards and the DOC# state write).
 *
 * Double-booking protection:
 *   1. RESERVE the charge key atomically BEFORE the POST — a concurrent booking of the same
 *      charge loses the reservation and gets `duplicate` without ever calling QBO.
 *   2. A QBO 409 (purchase already exists) is reported as `duplicate`, NOT as a new booking.
 *   3. The reservation is released on failure and finalized (with the purchase id) on success.
 *
 * `override` bypasses (1) for an explicit human rebook; the final marker still never clobbers
 * an existing booked marker.
 *
 * `chargeKey` is an INPUT (not computed here); with no key there is no marker and no reservation.
 */
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { logger } from '../utils/logger'
import { finalizeMarker, releaseReservation, reserveCharge } from './chargeMarker'

/** QBO purchase POST result. */
interface QboSubmitResult {
  success: boolean
  /** QBO answered 409: the purchase already exists (ids below point at it). */
  duplicate?: boolean
  docNumber?: string
  purchaseId?: string
  error?: string
  intuitTid?: string
  /** `error.code` from the QBO Service error body (e.g. QBO_AUTH_EXPIRED), if present. */
  errorCode?: string
}

export interface SubmitChargeInput {
  /** The QBO purchase payload (built by the caller). */
  qboPayload: unknown
  /** Document id — used for logging + marker provenance. */
  documentId: string

  // ─── Dedup context (optional — when `chargeKey` is absent, no marker) ──────
  /** CHARGE#{vendorId}#INV#{n} (or the amount+date fallback). */
  chargeKey?: string
  vendorId?: string
  invoiceNumber?: string
  amount?: number
  documentDate?: string
  /** Explicit human rebook: skip the reservation (QBO may still answer duplicate). */
  override?: boolean

  // ─── Attachment context (optional — best-effort) ──────────────────────────
  /** When present, the source PDF is attached best-effort after booking. */
  originalUri?: string
}

export interface SubmitChargeResult {
  /** True only for a NEW booking (`status === 'submitted'`). */
  success: boolean
  status: 'submitted' | 'failed' | 'duplicate'
  qboPurchaseId?: string
  qboDocNumber?: string
  /** `duplicate` only: who already holds the charge — our marker, or QBO itself (409). */
  duplicateSource?: 'marker' | 'qbo'
  attachmentUploaded?: boolean
  attachmentFailed?: boolean
  error?: string
  /** `intuit_tid` captured from a QBO error response for triage. */
  intuitTid?: string
  /** Typed `error.code` from the QBO Service body (e.g. `QBO_AUTH_EXPIRED`). */
  errorCode?: string
}

/** Injected dependencies; build the standard set with `getBookingDeps()`. */
export interface SubmitChargeDeps {
  /** Returns a valid Bearer token for the QBO Service. */
  getAuthToken: () => Promise<string>
  /** The QBO Service base URL (e.g. https://qbo-service.test). */
  qboServiceUrl: string
  /** DynamoDB table name for the dedup marker. */
  tableName: string
  /** Best-effort PDF attach. Omitted by callers that cannot fetch the PDF. */
  attachPdf?: (
    purchaseId: string,
    originalUri: string,
  ) => Promise<{ success: boolean; error?: string }>
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
  const { documentId, chargeKey: charge } = input

  // ─── 1. Reserve the charge key (closes the check-then-act race) ────────────
  const reserving = !!charge && !input.override
  if (reserving) {
    const reservation = await reserveCharge(ddb, deps.tableName, charge, documentId)
    if (!reservation.reserved) {
      logger.info('submitCharge: charge already reserved/booked', { documentId, chargeKey: charge })
      return {
        success: false,
        status: 'duplicate',
        duplicateSource: 'marker',
        qboPurchaseId: reservation.existing?.qboPurchaseId,
      }
    }
  }

  // ─── 2. POST to QBO ────────────────────────────────────────────────────────
  const qbo = await submitToQbo(input.qboPayload, deps)

  if (!qbo.success) {
    if (reserving) await releaseReservation(ddb, deps.tableName, charge, documentId)
    logger.warn('submitCharge: QBO booking failed', {
      documentId,
      error: qbo.error,
      intuitTid: qbo.intuitTid,
      errorCode: qbo.errorCode,
    })
    return {
      success: false,
      status: 'failed',
      error: qbo.error,
      intuitTid: qbo.intuitTid,
      errorCode: qbo.errorCode,
    }
  }

  const qboPurchaseId = qbo.purchaseId
  const qboDocNumber = qbo.docNumber

  // ─── 3. Finalize the marker (reservation → booked) ─────────────────────────
  if (charge && qboPurchaseId) {
    // QBO is already booked: a marker write failure must not lose the purchase id. The
    // reservation goes stale and the caller still records the booking on the expense.
    await finalizeMarker(ddb, deps.tableName, {
      pk: charge,
      sk: 'marker',
      qboPurchaseId,
      documentId,
      vendorId: input.vendorId ?? '',
      invoiceNumber: input.invoiceNumber,
      amount: input.amount ?? 0,
      documentDate: input.documentDate ?? '',
      bookedAt: new Date().toISOString(),
    }).catch((err) =>
      logger.error('Failed to finalize charge marker after QBO booking', {
        documentId,
        qboPurchaseId,
        error: String(err),
      }),
    )
  } else if (reserving) {
    // QBO accepted but gave no purchase id: nothing to record, don't leave a dangling claim.
    await releaseReservation(ddb, deps.tableName, charge, documentId)
  }

  if (qbo.duplicate) {
    logger.info('submitCharge: QBO reports duplicate purchase', { documentId, qboPurchaseId })
    return {
      success: false,
      status: 'duplicate',
      duplicateSource: 'qbo',
      qboPurchaseId,
      qboDocNumber,
    }
  }

  logger.info('submitCharge: QBO booking succeeded', { documentId, qboPurchaseId, qboDocNumber })
  const result: SubmitChargeResult = {
    success: true,
    status: 'submitted',
    qboPurchaseId,
    qboDocNumber,
  }

  // ─── 4. Best-effort PDF attach ─────────────────────────────────────────────
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

    // 409 = QBO already holds this purchase → report it as a duplicate, never as a new booking.
    if (response.status === 409) {
      const data = (await response.json()) as {
        existing?: { id?: string; docNumber?: string }
        id?: string
        docNumber?: string
      }
      return {
        success: true,
        duplicate: true,
        docNumber: data.existing?.docNumber ?? data.docNumber,
        purchaseId: data.existing?.id ?? data.id,
      }
    }

    if (!response.ok) {
      const errorBody = await response.text()
      const { errorCode, bodyTid } = parseErrorBody(errorBody)
      const intuitTid = extractIntuitTid(response) ?? bodyTid
      logger.error('QBO submission failed', {
        errorClass: 'qbo_api',
        httpStatus: response.status,
        errorName: 'QboApiError',
        errorMessage: `QBO API error ${response.status}`,
        intuitTid,
        errorCode,
      })
      return {
        success: false,
        error: `QBO API error ${response.status}: ${errorBody}`,
        intuitTid,
        errorCode,
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
const extractIntuitTid = (response: {
  headers?: { get?: (k: string) => string | null }
}): string | undefined => {
  const tid = response.headers?.get?.('intuit_tid') ?? undefined
  return tid ?? undefined
}

/**
 * Parse `{ error: { code }, intuitTid }` from a QBO Service error body.
 * Tolerates non-JSON / unexpected shapes (returns undefined fields).
 */
const parseErrorBody = (raw: string): { errorCode?: string; bodyTid?: string } => {
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: unknown }; intuitTid?: unknown }
    return {
      errorCode: typeof parsed?.error?.code === 'string' ? parsed.error.code : undefined,
      bodyTid: typeof parsed?.intuitTid === 'string' ? parsed.intuitTid : undefined,
    }
  } catch {
    return {}
  }
}
