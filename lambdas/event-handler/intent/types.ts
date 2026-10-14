/**
 * FINANCIAL-INTENT TYPES (Stage 2 + Stage 3)
 * ────────────────────────────────────────────────────────────────────────────
 * Shared contract for the accrual-based intent layer per
 * .kiro/specs/expense-intent-classification/design.md.
 *
 *  - Stage 2 (classifyIntent): LLM lifecycle classification. ADVISORY.
 *  - Stage 3 (decideBooking):  deterministic book/skip/review. SOLE QBO authority.
 */

/** Lifecycle stage of a financial document (accrual bookkeeping). */
export type FinancialIntent = 'bill' | 'reminder' | 'receipt' | 'statement' | 'unknown'

export type IntentConfidence = 'high' | 'medium' | 'low'

/** Stage-2 Bedrock output (advisory). */
export interface IntentResult {
  financialIntent: FinancialIntent
  /** Vendor's own invoice/document number for THIS charge, if present. */
  invoiceNumber?: string
  /** Invoice numbers this doc references (payments/statements). [] if none/one. */
  referencedInvoiceNumbers: string[]
  intentConfidence: IntentConfidence
  intentRationale: string
}

/** Stage-3 deterministic outcome. */
export type BookingOutcome =
  | { action: 'book'; chargeKey: string }
  | { action: 'skip_duplicate'; chargeKey: string; existingQboPurchaseId: string }
  | { action: 'informational'; reason: string }
  | { action: 'needs_review'; reason: string }

export interface DecisionInput {
  intent: FinancialIntent
  intentConfidence: IntentConfidence
  vendorId: string
  invoiceNumber?: string
  referencedInvoiceNumbers: string[]
  amount: number
  documentDate: string
  /** Dedup read — injected so decideBooking stays pure/unit-testable. */
  lookupCharge: (chargeKey: string) => { qboPurchaseId: string } | undefined
  /** Minimum intent confidence to allow an automated booking. */
  confidenceFloor: IntentConfidence
}
