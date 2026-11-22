# E2 contract: `POST /expenses/from-document/{documentId}`

Ticket: bdk-data-management-frontend#13. Spec: `bdk-data-management-frontend/.kiro/specs/expense-editability/spec.md`.
Consumer: E4 (DocumentDetail "Book as expense", hook `useCreateExpenseFromDocument`).

Open-or-create the expense (`DOC#{id}/state`) of any Parsely document, whatever its type. It never calls QBO and
never books. Booking stays the separate `POST /expenses/{documentId}/correct-and-submit` action.

## Request

- `POST {expenseApiUrl}/expenses/from-document/{documentId}`
- Header: `Authorization: Bearer <Cognito JWT>` (same authorizer as every other expense route).
- Body: none. The body is not read, so an empty body, `{}` or anything else is ignored. The spec's `override?`
  is not implemented: nothing is booked here, so there is nothing to override (un-skip and dedup overrides stay on
  correct-and-submit).
- The tenant comes from the JWT (`custom:tenantId`), never from the body or path.

## Responses

All error bodies use the shared envelope `{ "message": string, ...extra }`.

| Status | When | Body |
| --- | --- | --- |
| 201 | No expense existed; one was created | `{ "created": true, "expense": ExpenseState }` |
| 200 | An expense already existed (including a lost create race); returned untouched, never reset | `{ "created": false, "expense": ExpenseState }` |
| 400 | Missing `documentId` | `{ "message": "documentId path parameter is required" }` |
| 404 | Parsely has no such document for the caller's tenant, or the document/expense belongs to another tenant | `{ "message": "Document not found: {id}", "error": "DOCUMENT_NOT_FOUND" }` |
| 502 | Parsely unreachable, token failure, or non-2xx other than 404 | `{ "message": "Parsely is unavailable — try again shortly", "error": "PARSELY_UNAVAILABLE" }` |
| 500 | Unexpected | `{ "message": "Internal server error" }` |

There is no 409. Status 401/403 come from the API Gateway JWT authorizer.

The FE decides what to do from `created` and `expense.status`:
a 200 with `expense.status === 'submitted'` means the document is already booked: open it read-only.

## Created item (201)

```json
{
  "pk": "DOC#{documentId}", "sk": "state",
  "tenantId": "<document tenant>",
  "documentId": "{documentId}",
  "status": "needs_input",
  "needsInputType": "review",
  "bookingOwner": "human",
  "vendorName": "<document vendorName, or 'unknown'>",
  "vendorDisplay": "<document vendorDisplay, may be absent>",
  "documentDate": "<document documentDate, or ''>",
  "amounts": ["$1,234.00"],
  "description": "<document description, may be absent>",
  "originalUri": "s3://.../original.pdf",
  "attempts": 0,
  "createdAt": "ISO-8601", "updatedAt": "ISO-8601"
}
```

- `amounts` are copied as Parsely strings (`"$1,234.00"`); use `parseAmount` on the client as for every other expense.
- `needsInputType: 'review'` is new. It means "nothing is wrong; awaiting the human". There are no `validationErrors`.
  The FE must treat unknown `needsInputType` values as a plain review state.
- There is no `qboVendorRef`, `qboPayload` or `parsedLines`. The user picks vendor and account in the edit form
  and books with correct-and-submit (which validates and returns the existing 400 field errors).
- `bookingOwner: 'human'` means the event-handler (reprocess, re-upload, SQS redelivery) never overwrites the item.
  The hold is enforced by DynamoDB conditions (`bookingOwner <> 'human'`), not only a read-then-check.
- Document of any type is accepted (the human is the authority). Missing vendor/date/amounts are not an error.

## Idempotency and races

- Existing item: returned as-is (200, `created: false`). Its status, fields and `bookingOwner` are not modified,
  so calling this for a `submitted`, `skipped`, or pipeline-owned item is safe.
- Two concurrent calls: creation is `attribute_not_exists(pk)`. The loser re-reads and gets 200 with the winner's item.
- A pipeline event arriving first is also "the existing item" (200). One arriving after is rejected by the hold.

## Tenant scoping

- Parsely is called with the Expense API's machine token; Parsely scopes the lookup to that token's tenant.
- If the caller's JWT has `custom:tenantId`, it must equal the document's tenant (and, for an existing item, the
  item's tenant); otherwise 404 (no existence leak). A machine-token caller has no tenant claim and is accepted.

## Infrastructure (for the deploy)

- New env var on `{Stage}-BDK-ExpenseProcessor-Api`: `PARSELY_API_URL`, read from SSM `/{Stage}/datamgmt/api-url`.
- That parameter does NOT exist today. It must hold the Parsely HTTP API endpoint without a trailing slash, e.g. Beta:
  `https://xloboqgzpb.execute-api.us-west-2.amazonaws.com`. Create it before deploying `Beta-BDK-ExpenseProcessor-Api`
  (a missing parameter fails the CloudFormation deploy before any change is made).
- New API Gateway route `POST /expenses/from-document/{documentId}` (JWT authorizer). No new IAM.
