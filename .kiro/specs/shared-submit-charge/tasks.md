# Tasks: Shared `submitCharge` Booking Module (BDK #2)

> Lane: BDK · Repo: `bdk-expense-processor` · Issue: `bdk-data-management-frontend#2`

## T1 — Create the module
- [ ] Add `lambdas/shared/booking/submitCharge.ts` with `SubmitChargeInput`,
      `SubmitChargeResult`, `submitCharge(input, ddb)` per design.
- [ ] Move the QBO POST + 409 handling (currently `submitToQbo` in event-handler) into it.
- [ ] Conditional `CHARGE#` marker write (identical item shape to current event-handler).
- [ ] Best-effort `attachPdf` integration; capture `intuit_tid` on failure.
- [ ] Structured logging per BDK convention.

## T2 — Refactor event-handler
- [ ] Replace steps 8–9a inline block with `submitCharge(...)`.
- [ ] Delete the now-duplicated `submitToQbo` + inline `writeChargeMarker` call path
      (keep `writeChargeMarker` only if still referenced; otherwise move into module).
- [ ] Verify state-writing (step 10) and notifications unchanged.

## T3 — Refactor manual API handlers
- [ ] `setAccount.ts`: book via `submitCharge`; compute `chargeKey` with the shared rule
      `invoiceNumber ? chargeKey(...) : fallbackChargeKey(...)` (import from `decideBooking.ts`);
      OMIT `originalUri` (no attach — R1); map result to the existing `UpdateCommand`.
- [ ] `submitExpenses.ts`: book via `submitCharge`; same chargeKey rule (fallback from the
      replayed payload's amount+date if no invoice number); omit `originalUri`.
- [ ] `retryExpenses.ts`: book via `submitCharge`; same chargeKey rule; omit `originalUri`.

## T4 — (resolved — no CDK change in this ticket)
- [ ] CONFIRM manual callers omit `originalUri` so no S3/attach is attempted (R1 resolved;
      manual-path attachment is follow-up `bdk-data-management-frontend#7`).

## T5 — Tests
- [ ] Unit: `submitCharge` — success writes marker; 409 → success+existing id; non-2xx →
      failed + error + intuitTid; attach failure → `attachmentFailed`, booking intact;
      no `chargeKey` → no marker write.
- [ ] Regression: `setAccount` submit writes marker → event-handler reprocess of same
      invoice returns `skip_duplicate` (no second QBO POST). (Mock QBO + DDB.)
- [ ] Existing event-handler C-T6 tests pass unchanged.

## T6 — Verify
- [ ] `npm run build` clean.
- [ ] Full unit suite green.
- [ ] Grep: no `/purchases` POST or `CHARGE#` marker put outside `submitCharge`.

## Out of scope / follow-ups
- Path B correct-and-submit API (issue #3) consumes this module.
- If T4 requires a CDK grant, that is a small ApiStack change — include in this PR or a
  tightly-scoped follow-up, not a separate epic.
