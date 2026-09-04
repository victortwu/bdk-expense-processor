/**
 * CANONICAL DocumentProcessed EVENT CONTRACT (shared source of truth)
 * ────────────────────────────────────────────────────────────────────────────
 * This fixture is the authoritative shape of the `detail` payload that Parsely's
 * processing Lambda emits on EventBridge (`Source: parsely.processing`,
 * `DetailType: DocumentProcessed`) and that the BDK Expense Processor consumes
 * off SQS.
 *
 * WHY THIS FILE EXISTS
 * The producer (`data-management-cdk` → emitDocumentProcessedEvent) and the
 * consumer (`bdk-expense-processor` → DocumentProcessedDetail) live in separate
 * repos and can drift silently. This fixture pins the wire shape so BOTH sides
 * can test against it:
 *   - Parsely asserts emitDocumentProcessedEvent produces this shape.
 *   - The Expense Processor Tier-1 handler test consumes this exact shape.
 *
 * PRODUCER IS AUTHORITATIVE
 * The shape below mirrors what Parsely ACTUALLY puts on the wire (derived from
 * DocumentRecord + emitDocumentProcessedEvent), NOT what either TypeScript type
 * currently claims. Two facts the code proves and this fixture encodes:
 *
 *   1. `amounts` is a string[] of DOLLAR-FORMATTED strings (e.g. "$475.65",
 *      "$2,847.00") — Bedrock returns them formatted with "$" and thousands
 *      separators. The consumer type currently declares `number[]`, which is a
 *      contract mismatch (see MISMATCH note below). The wire truth is string[].
 *
 *   2. Several fields are OPTIONAL on the producer (subType, vendorName,
 *      vendorDisplay, documentDate, description, confidence, originalUri) because
 *      DocumentRecord marks them `?`. A low-confidence / unknown document can
 *      legitimately arrive with these missing. The consumer type currently
 *      declares them required `string`, which overstates the guarantee.
 *
 * KNOWN MISMATCH (documented, not yet resolved):
 *      Consumer `DocumentProcessedDetail` declares `amounts: number[]` and marks
 *      subType/vendorName/etc. as required. The producer emits `amounts: string[]`
 *      with optional fields. The expense handler reads `detail.amounts || []`
 *      straight into ExpenseState.amounts (typed number[]). This fixture makes
 *      the discrepancy explicit so the reconciliation is a conscious decision,
 *      not an accident. Resolution is tracked separately (see memory-bank).
 */

/** The canonical, fully-populated happy-path event (single-line vendor receipt). */
export const CANONICAL_DOCUMENT_PROCESSED_DETAIL = {
  tenantId: 'bdk',
  documentId: '01J8XZQK3P0000000000000001',
  documentType: 'financial',
  subType: 'receipt',
  vendorName: 'franz-bakery',
  vendorDisplay: 'Franz Bakery',
  documentDate: '2026-07-25',
  amounts: ['$475.65'], // string[], dollar-formatted — producer truth
  description: 'Franz Bakery delivery receipt for bread products.',
  confidence: 'high',
  source: 'upload',
  extractedTextUri:
    's3://parsely-processed-beta/documents/bdk/01J8XZQK3P0000000000000001/extracted.txt',
  originalUri:
    's3://parsely-processed-beta/documents/bdk/01J8XZQK3P0000000000000001/original.pdf',
} as const

/**
 * The EventBridge envelope Parsely emits. The `detail` is JSON-stringified by
 * EventBridge; consumers receive it (via SQS) and JSON.parse the SQS record body,
 * whose `.detail` is this object. Kept here so the Tier-1 handler test can build a
 * faithful SQS record.
 */
export const CANONICAL_EVENTBRIDGE_ENVELOPE = {
  source: 'parsely.processing',
  'detail-type': 'DocumentProcessed',
  detail: CANONICAL_DOCUMENT_PROCESSED_DETAIL,
} as const

/**
 * The exact set of `detail` keys the producer emits, in emission order.
 * Parsely's emit test asserts against this to catch added/removed fields.
 */
export const CANONICAL_DETAIL_KEYS = [
  'tenantId',
  'documentId',
  'documentType',
  'subType',
  'vendorName',
  'vendorDisplay',
  'documentDate',
  'amounts',
  'description',
  'confidence',
  'source',
  'extractedTextUri',
  'originalUri',
] as const

/**
 * A minimal event exercising the OPTIONAL-fields reality: a low-confidence doc
 * where Bedrock could not resolve subType/vendor/date. Producer emits these as
 * `undefined` (dropped by JSON.stringify). Consumers must tolerate their absence.
 */
export const MINIMAL_DOCUMENT_PROCESSED_DETAIL = {
  tenantId: 'bdk',
  documentId: '01J8XZQK3P0000000000000002',
  documentType: 'financial',
  amounts: ['$12.00'],
  source: 'email',
  extractedTextUri:
    's3://parsely-processed-beta/documents/bdk/01J8XZQK3P0000000000000002/extracted.txt',
} as const
