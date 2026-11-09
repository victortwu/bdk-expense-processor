/**
 * `bookExpense` — THE booking path. Every route that books an expense to QBO
 * (event-handler, correct-and-submit, set-account, bulk submit/retry) goes through here:
 *
 *   refuse re-booking submitted/skipped (unless explicit override)
 *   → marker pre-check (adopt our own earlier booking; refuse someone else's)
 *   → submitCharge (atomic reservation, QBO POST, final marker, PDF attach)
 *   → markSubmitted / markFailed (conditional DOC# transition)
 *
 * It returns a typed outcome and never writes HTTP or notifications — callers map it.
 */
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { expenseRepo } from '../expense/expenseRepo'
import { ExpenseStatus } from '../expense/status'
import { logger } from '../utils/logger'
import { getMarker, isBlockingMarker } from './chargeMarker'
import { BOOKABLE_FROM, BookedExpense, markFailed, markSubmitted } from './markSubmitted'
import { parseAmount } from '../utils/parseAmount'
import { submitCharge, SubmitChargeDeps, SubmitChargeResult } from './submitCharge'

export interface BookExpenseParams {
  documentId: string
  /** Status of the expense as loaded by the caller. */
  status: ExpenseStatus
  booked: BookedExpense
  originalUri?: string
  /** Explicit human override: allows rebooking a submitted/skipped expense or ignoring a marker. */
  override?: boolean
}

export type BookRefusal = 'already_submitted' | 'skipped_requires_override'

export type BookOutcome =
  /** Booked now (or, `adopted`, an existing QBO purchase was recorded against this expense). */
  | { kind: 'submitted'; result: SubmitChargeResult; adopted: boolean }
  | { kind: 'failed'; result: SubmitChargeResult }
  | { kind: 'refused'; reason: BookRefusal }
  /** The charge is already booked (or being booked) by someone else. */
  | { kind: 'duplicate'; existingPurchaseId?: string }
  /** QBO was booked but the DOC# state changed underneath us (e.g. skipped meanwhile). */
  | { kind: 'conflict'; result: SubmitChargeResult }

/** Status gate shared by `bookExpense` and handlers that want to fail fast before validation. */
export const bookRefusal = (status: ExpenseStatus, override?: boolean): BookRefusal | undefined => {
  if (override) return undefined
  if (status === ExpenseStatus.Submitted) return 'already_submitted'
  if (status === ExpenseStatus.Skipped) return 'skipped_requires_override'
  return undefined
}

export const bookExpense = async (
  params: BookExpenseParams,
  ddb: DynamoDBDocumentClient,
  deps: SubmitChargeDeps,
): Promise<BookOutcome> => {
  const { documentId, status, booked, override } = params
  const repo = expenseRepo(ddb, deps.tableName)

  const reason = bookRefusal(status, override)
  if (reason) return { kind: 'refused', reason }

  // Overriding a submitted/skipped expense may leave either status; otherwise only unbooked ones.
  const from = override
    ? [...BOOKABLE_FROM, ExpenseStatus.Submitted, ExpenseStatus.Skipped]
    : BOOKABLE_FROM

  /** Record an already-existing QBO purchase against this expense (no new QBO write). */
  const adopt = async (result: SubmitChargeResult): Promise<BookOutcome> => {
    const written = await markSubmitted(repo, documentId, booked, result, from)
    return written ? { kind: 'submitted', result, adopted: true } : { kind: 'conflict', result }
  }

  // ─── Marker pre-check ──────────────────────────────────────────────────────
  if (!override) {
    const marker = await getMarker(ddb, deps.tableName, booked.chargeKey)
    // A stale orphan reservation does not block: submitCharge takes it over.
    if (marker && isBlockingMarker(marker)) {
      if (marker.documentId === documentId && marker.qboPurchaseId) {
        // Our own earlier booking whose state write was lost — repair, don't re-book.
        return adopt({ success: true, status: 'submitted', qboPurchaseId: marker.qboPurchaseId })
      }
      return { kind: 'duplicate', existingPurchaseId: marker.qboPurchaseId }
    }
  }

  const result = await submitCharge(
    {
      qboPayload: booked.qboPayload,
      documentId,
      chargeKey: booked.chargeKey,
      vendorId: booked.vendorRef.value,
      invoiceNumber: booked.invoiceNumber,
      amount: parseAmount(booked.amounts[0]),
      documentDate: booked.documentDate,
      override,
      originalUri: params.originalUri,
    },
    ddb,
    deps,
  )

  switch (result.status) {
    case 'failed':
      if (!(await markFailed(repo, documentId, result.error))) {
        logger.warn('Booking failed but the failure was not recorded (state changed)', {
          documentId,
          error: result.error,
        })
      }
      return { kind: 'failed', result }
    case 'duplicate':
      // QBO itself already holds this purchase and nothing is recorded against a booked expense:
      // adopt it. Anything else (marker held by another booking, rebook of a submitted expense)
      // must not be passed off as a new booking.
      return result.duplicateSource === 'qbo' && status !== ExpenseStatus.Submitted
        ? adopt(result)
        : { kind: 'duplicate', existingPurchaseId: result.qboPurchaseId }
    default: {
      const written = await markSubmitted(repo, documentId, booked, result, from)
      if (!written) {
        logger.error('Booked in QBO but state transition was rejected', {
          documentId,
          qboPurchaseId: result.qboPurchaseId,
        })
        return { kind: 'conflict', result }
      }
      return { kind: 'submitted', result, adopted: false }
    }
  }
}
