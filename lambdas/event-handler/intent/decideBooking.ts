/**
 * STAGE 3 — DETERMINISTIC BOOK / SKIP / REVIEW  (SOLE QBO AUTHORITY)
 * ────────────────────────────────────────────────────────────────────────────
 * Pure function (no AWS/LLM). The dedup read is injected as `lookupCharge`, so
 * this is fully unit-testable. Maps the advisory Stage-2 intent to an accrual
 * booking decision, with dedup + multi-invoice guards.
 *
 * Policy (accrual): the BILL is the authoritative booking event. Reminders and
 * receipts are informational and never book. Bias to NOT booking on ambiguity —
 * an under-book (needs_review) is strongly preferred over a false booking.
 *
 * See .kiro/specs/expense-intent-classification/design.md (Stage 3).
 */
import { BookingOutcome, DecisionInput, IntentConfidence } from './types'

const CONFIDENCE_RANK: Record<IntentConfidence, number> = { low: 0, medium: 1, high: 2 }
const rank = (c: IntentConfidence): number => CONFIDENCE_RANK[c]

/** Primary charge identity: vendor + the vendor's own invoice number. */
export const chargeKey = (vendorId: string, invoiceNumber: string): string =>
  `CHARGE#${vendorId}#INV#${invoiceNumber}`

/** Fallback identity (review-only on match): vendor + amount + date. */
export const fallbackChargeKey = (
  vendorId: string,
  amount: number,
  documentDate: string,
): string => `CHARGE#${vendorId}#AMT#${amount.toFixed(2)}#${documentDate}`

export const decideBooking = (i: DecisionInput): BookingOutcome => {
  // 1) Low-confidence → review (fail-safe).
  if (rank(i.intentConfidence) < rank(i.confidenceFloor)) {
    return { action: 'needs_review', reason: 'low_intent_confidence' }
  }

  // 2) Non-bill intents never book.
  if (i.intent === 'reminder') return { action: 'informational', reason: 'reminder' }
  if (i.intent === 'statement') return { action: 'informational', reason: 'statement' }
  if (i.intent === 'unknown') return { action: 'needs_review', reason: 'unknown_intent' }
  if (i.intent === 'receipt') {
    const anyBooked = i.referencedInvoiceNumbers.some((n) =>
      i.lookupCharge(chargeKey(i.vendorId, n)),
    )
    return anyBooked
      ? { action: 'informational', reason: 'receipt_for_booked_charge' }
      : { action: 'needs_review', reason: 'receipt_without_recorded_bill' }
  }

  // intent === 'bill' below.
  // 3) Multi-invoice guard (LLM-independent): a "bill" referencing many invoices
  //    is almost certainly a payment/statement → review, never book.
  if (i.referencedInvoiceNumbers.length > 1) {
    return { action: 'needs_review', reason: 'multiple_invoice_references' }
  }

  // 4) Charge identity + dedup.
  const usingFallback = !i.invoiceNumber
  const key = i.invoiceNumber
    ? chargeKey(i.vendorId, i.invoiceNumber)
    : fallbackChargeKey(i.vendorId, i.amount, i.documentDate)

  const existing = i.lookupCharge(key)
  if (existing) {
    // Fallback-key match is only a HINT (amount is not an identity) → review.
    // Primary-key match → safe skip.
    return usingFallback
      ? { action: 'needs_review', reason: 'possible_duplicate_fallback_key' }
      : { action: 'skip_duplicate', chargeKey: key, existingQboPurchaseId: existing.qboPurchaseId }
  }

  return { action: 'book', chargeKey: key }
}
