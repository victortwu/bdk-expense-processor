import { BookOutcome } from '../../shared/booking/bookExpense'
import { ApiResponse, respond } from '../../shared/http/respond'

type Failure = Exclude<BookOutcome, { kind: 'submitted' }>

/** One-line, human-readable reason a booking did not happen (bulk results + logs). */
export const bookFailureMessage = (outcome: Failure): string => {
  switch (outcome.kind) {
    case 'failed':
      return outcome.result.error || 'QBO submission failed'
    case 'refused':
      return outcome.reason === 'already_submitted'
        ? 'Expense already submitted to QBO — set override to rebook'
        : 'This expense was skipped — set override to book it anyway'
    case 'duplicate':
      return outcome.existingPurchaseId
        ? `Looks already booked as purchase ${outcome.existingPurchaseId}`
        : 'This charge is already being booked — try again shortly'
    case 'conflict':
      return outcome.result.qboPurchaseId
        ? `Booked in QBO as purchase ${outcome.result.qboPurchaseId}, but the expense changed meanwhile — reload to see its current state`
        : 'Booked in QBO, but the expense changed meanwhile — reload to see its current state'
  }
}

/**
 * Map a booking outcome to the HTTP response of the single-expense endpoints.
 * 409 wire contract (the FE branches on it, see ApiError.kind): `qboPurchaseId` present ⇒
 * "already booked" (offers an override rebook), so it is sent ONLY for a genuine existing
 * booking; every other 409 carries an `error` code instead.
 * `expensePurchaseId` is the purchase already recorded on the loaded expense, if any.
 */
export const respondToBookOutcome = (
  outcome: BookOutcome,
  successMessage: string,
  expensePurchaseId?: string,
): ApiResponse => {
  switch (outcome.kind) {
    case 'submitted':
      return respond(200, {
        message: outcome.adopted
          ? `Expense already existed in QBO — linked to purchase ${outcome.result.qboPurchaseId}`
          : successMessage,
        purchaseId: outcome.result.qboPurchaseId,
        // The PDF attach is best-effort — a failure never rolls back the booking (BDK #7).
        attachmentFailed: outcome.result.attachmentFailed,
      })
    case 'refused':
      return outcome.reason === 'already_submitted'
        ? respond(409, {
            message: bookFailureMessage(outcome),
            qboPurchaseId: expensePurchaseId,
          })
        : respond(409, {
            message: bookFailureMessage(outcome),
            error: 'SKIPPED_REQUIRES_OVERRIDE',
            currentStatus: 'skipped',
          })
    case 'duplicate':
      return respond(
        409,
        outcome.existingPurchaseId
          ? { message: bookFailureMessage(outcome), qboPurchaseId: outcome.existingPurchaseId }
          : { message: bookFailureMessage(outcome), error: 'BOOKING_IN_PROGRESS' },
      )
    case 'conflict':
      // QBO WAS booked; this must not look like "already booked — rebook?" (no qboPurchaseId).
      return respond(409, {
        message: bookFailureMessage(outcome),
        error: 'STATE_CONFLICT',
        purchaseId: outcome.result.qboPurchaseId,
      })
    case 'failed':
      // A bare 401 is ambiguous (our own M2M token can be rejected too); the QBO Service
      // signals an expired QBO connection with the typed QBO_AUTH_EXPIRED code.
      return outcome.result.errorCode === 'QBO_AUTH_EXPIRED'
        ? respond(502, {
            message: 'QBO connection expired — reconnect QBO and try again',
            error: 'QBO_AUTH_EXPIRED',
            intuitTid: outcome.result.intuitTid,
          })
        : respond(502, { message: `QBO submission failed: ${bookFailureMessage(outcome)}` })
  }
}
