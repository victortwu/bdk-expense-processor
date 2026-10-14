# Spec: Shared `submitCharge` Booking Module (BDK #2)

> Lane: BDK · Repo: `bdk-expense-processor` · Epic: `bdk-data-management-frontend#1`
> Issue: `bdk-data-management-frontend#2` · Status: Draft

## Summary

Extract the "book a charge to QBO" operation into a single shared module so every
booking path — the automated SQS event-handler AND the human-initiated API handlers —
goes through one tested primitive that **always writes the `CHARGE#` dedup marker**.

## Motivation (the live defect)

Grounding read (2026-10-14) found submit → QBO → dedup-marker → PDF-attach duplicated
across three places, and only ONE writes the marker:

| Call site | POSTs to QBO | Writes `CHARGE#` marker | Attaches PDF | Handles 409 |
|---|---|---|---|---|
| `event-handler/index.ts` (steps 8–9a) | ✅ | ✅ | ✅ | ✅ |
| `api/handlers/setAccount.ts` | ✅ | ❌ | ❌ | ✅ (as success) |
| `api/handlers/submitExpenses.ts` | ✅ | ❌ | ❌ | ❌ (treats non-2xx as error) |
| `api/handlers/retryExpenses.ts` | ✅ | ❌ | ❌ | ❌ |

**Consequence:** a manual submit (`setAccount`) creates a QBO purchase that the dedup
ledger never records. A later Path-A reprocess of the same invoice does not find a
marker → re-books → **double-book**. The duplication also guarantees drift as the
booking logic evolves.

## Goals

- One module is the sole writer of QBO purchases + `CHARGE#` markers + PDF attachments.
- Dedup protection becomes uniform across automated and manual booking.
- No behavior change to the automated C-T6 path (regression-safe refactor).

## Non-Goals

- The Path B correct-and-submit API (separate issue, consumes this module).
- The intent gate / `decideBooking` logic (unchanged; the module is downstream of the
  booking decision).
- Changing the QBO Service API or the `CHARGE#` key scheme.

## Functional Requirements

- **FR1** A `submitCharge` module exposes a single function that, given a QBO purchase
  payload + dedup/attachment context, performs: authenticated POST to QBO `/purchases`
  → 409-as-success handling → conditional `CHARGE#` marker write → best-effort PDF
  attach → returns a normalized result.
- **FR2** The `CHARGE#` marker write is a conditional put (`attribute_not_exists(pk)`),
  identical to the current event-handler behavior; a re-book never clobbers an existing
  marker.
- **FR3** PDF attachment is best-effort: a failed attach never fails the booking; it is
  reported in the result (`attachmentUploaded` / `attachmentFailed`).
- **FR4** 409 from QBO is treated as success, surfacing the existing purchase id/docNumber.
- **FR5** The event-handler, `setAccount`, `submitExpenses`, and `retryExpenses` all book
  through this module. After the refactor, `setAccount`/`submitExpenses`/`retryExpenses`
  write the dedup marker on success.
- **FR6** The module is callable from both the SQS Lambda and the API Lambda (shared
  location, no handler-specific imports).

## Non-Functional Requirements

- **NFR1** The automated C-T6 path produces identical DynamoDB state + QBO calls as
  before (proven by the existing event-handler unit tests staying green).
- **NFR2** Structured logging per the BDK logging convention (QBO HTTP status +
  `intuit_tid` on failure; never log secrets/doc contents).
- **NFR3** The module does not own event or HTTP-response concerns — it is a booking
  primitive returning a plain result object; callers map it to SQS state / API responses.

## Acceptance Criteria (from the issue, agent-verifiable)

- [ ] `submitCharge` is the only code path that POSTs purchases + writes the `CHARGE#`
      marker + attaches the PDF (grep confirms no other `/purchases` POST or marker put).
- [ ] Existing event-handler C-T6 unit tests pass unchanged.
- [ ] Regression test: submit via `setAccount` → then reprocess the same invoice through
      the event-handler → outcome is `skip_duplicate` (no second QBO submit).
- [ ] `submitExpenses` / `retryExpenses` write the marker on success.
- [ ] 409 handled identically everywhere (success + existing id).
- [ ] `npm run build` + full unit suite green.

## Resolved Decisions (2026-10-14)

- **R1 — PDF attachment on manual paths: SKIP for now.** Verified in code: the Expense API
  Lambda (`ExpenseApiStack`) has NO `PROCESSED_BUCKET` env and NO processed-bucket read /
  processing-key decrypt grant → it cannot fetch the source PDF today. Manual callers
  therefore OMIT `originalUri` (so `submitCharge` does not attempt attach). This matches
  current behavior (setAccount/submitExpenses/retryExpenses never attached). Enabling
  manual-path attachment is a separate, scoped follow-up → **`bdk-data-management-frontend#7`**
  (adds env + cross-stack grant). The automated event-handler path keeps attaching as today.

- **OQ1/OQ2 — chargeKey derivation on manual paths: RESOLVED.** Every manual path writes a
  marker. The CALLER computes the key with one shared rule, reusing the exact helpers already
  exported from `decideBooking.ts`:
  `invoiceNumber ? chargeKey(vendorId, invoiceNumber) : fallbackChargeKey(vendorId, amount, documentDate)`.
  - `setAccount`: primary key when an invoice number is on the expense state, else fallback.
  - `submitExpenses` / `retryExpenses`: primary key if recoverable from the expense state,
    else the amount+date fallback from the replayed payload. Always write *a* marker.
  - This guarantees manual + automated paths produce IDENTICAL keys for the same charge, so
    cross-path dedup actually works. The fallback key is a weak hint (amount is not an
    identity) and carries a small same-vendor/same-day/same-amount collision risk — accepted,
    consistent with the automated path's review-only treatment of fallback matches, and
    strictly better than today's zero markers. `submitCharge` stays agnostic: it writes a
    marker iff `chargeKey` + `qboPurchaseId` are both present.
