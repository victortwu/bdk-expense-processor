# Design: Shared `submitCharge` Booking Module (BDK #2)

> Lane: BDK · Repo: `bdk-expense-processor`

## Module location & shape

New file: `lambdas/shared/booking/submitCharge.ts` (shared — importable by both
`event-handler/` and `api/`). It depends only on: a DDB DocumentClient (injected),
`fetch` to the QBO Service, `getAuthToken`, and `attachPdf`.

```ts
export interface SubmitChargeInput {
  qboPayload: unknown              // the purchase payload (built by caller)
  // Dedup context (optional — when absent, no marker is written):
  chargeKey?: string               // CHARGE#{vendorId}#INV#{n} (or fallback). Caller computes.
  vendorId?: string
  invoiceNumber?: string
  amount?: number
  documentDate?: string
  // Attachment context (optional — best-effort):
  originalUri?: string
  documentId: string               // for logging + marker provenance
}

export interface SubmitChargeResult {
  success: boolean
  status: 'submitted' | 'failed'
  qboPurchaseId?: string
  qboDocNumber?: string
  attachmentUploaded?: boolean
  attachmentFailed?: boolean
  error?: string
  intuitTid?: string               // captured from QBO error for triage
}

export const submitCharge = async (
  input: SubmitChargeInput,
  ddb: DynamoDBDocumentClient,
): Promise<SubmitChargeResult>
```

### Why `chargeKey` is passed in (not computed inside)

Keeps `submitCharge` agnostic to how the key is derived (primary invoice key vs
fallback amount+date key — that is the Stage-3 / caller's concern). Resolves OQ1/OQ2:
the module writes a marker **iff** `chargeKey` + `qboPurchaseId` are present. The
event-handler already has the key from `decideBooking`; manual paths compute it from the
corrected invoice number (or omit it to skip marker-writing on legacy replay paths —
a conscious, logged choice).

## Internal flow

1. `getAuthToken()` → `POST {QBO_SERVICE_URL}/purchases` with Bearer.
2. **409** → read `existing.id`/`existing.docNumber`, return `success:true, status:'submitted'`.
3. **non-2xx** → capture body + `intuit_tid` header, return `success:false, status:'failed', error, intuitTid`.
4. **2xx** → parse `id`/`docNumber`.
5. If `chargeKey && qboPurchaseId` → conditional `PutCommand` marker (pk=chargeKey,
   sk='marker', `attribute_not_exists(pk)`); `ConditionalCheckFailedException` → log + continue.
6. If `originalUri && qboPurchaseId` → `attachPdf()`; set `attachmentUploaded`/`attachmentFailed`.
7. Return normalized result.

The module does NOT write the `DOC#.../state` record and does NOT emit notifications —
callers own that (SQS handler writes state via `writeState`; API handlers via their
`UpdateCommand`). This preserves the current separation and keeps the module pure of
caller-specific state shapes.

## Refactor of call sites

- **event-handler/index.ts (steps 8–9a):** replace the inline `submitToQbo` + marker +
  attach block with a `submitCharge(...)` call, passing `bookingChargeKey`,
  `qboVendorRef.value`, invoice number, amount, date, `originalUri`. State-writing (step
  10) unchanged. `submitToQbo` helper deleted (moves into the module).
- **setAccount.ts:** after building `qboPayload`, call `submitCharge`. Compute `chargeKey`
  from the expense's invoice number if present (else omit → fallback behavior per OQ2).
  Marker now written → closes the double-book hole. Map result to the existing
  `UpdateCommand`.
- **submitExpenses.ts / retryExpenses.ts:** replay `expense.qboPayload` through
  `submitCharge`. These may only have the fallback key (no invoice number on the prebuilt
  payload) — document the decision; still better than today (no marker at all).

## Shared location & bundling

`lambdas/shared/booking/submitCharge.ts` sits alongside `lambdas/shared/utils/logger.ts`.
Both Lambdas already import from `lambdas/shared/` (logger, respond), so esbuild bundles
it into each — no CDK change, no new IAM (both Lambdas already have DDB RW + QBO env +
`attachPdf`'s S3 read / the event-handler has processed-bucket decrypt; verify the API
Lambda has S3 read for attachments — see Risks).

## Risks / edge cases

- **R1 — API Lambda S3 permission for attachments: RESOLVED (skip on manual paths).**
  Verified: the Expense API Lambda has no `PROCESSED_BUCKET` env and no processed-bucket
  read / processing-key decrypt. Manual callers OMIT `originalUri` → no attach attempted.
  Enabling it is follow-up `bdk-data-management-frontend#7`. The event-handler (which DOES
  have the grants) keeps passing `originalUri` and attaching as today.
- **R2 — amounts type.** `amounts` is string[] on the wire; `parseAmount` handles `$`/`,`.
  The module receives a numeric `amount` (caller parses) to stay pure.
- **R3 — marker provenance.** Keep the marker item shape identical to the current
  event-handler write so existing dedup reads are unaffected.
