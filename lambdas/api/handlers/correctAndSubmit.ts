/**
 * PATH B — direct correct & submit (BDK frontend #3)
 * ────────────────────────────────────────────────────────────────────────────
 * `POST /expenses/{documentId}/correct-and-submit`
 *
 * Lets a HUMAN book a corrected expense DIRECTLY to QuickBooks Online, bypassing
 * the automated intent gate — the human is the booking authority. The request
 * carries human-edited fields (vendorRef, lines[], documentDate, memo, …) and the
 * handler:
 *
 *   1. Loads the DOC#{id}/state item (404 if absent).
 *   2. Validates the edited payload BEFORE any QBO call (400 w/ field errors).
 *   3. Pre-POST dedup check against the CHARGE# marker (409 unless `override`).
 *   4. Builds a MULTI-LINE QBO payload from the edited lines.
 *   5. Books via the shared `submitCharge` primitive — so the CHARGE# dedup
 *      marker is written (closing the double-book hole, BDK #2).
 *   6. Writes the DOC# state (submitted / failed) and responds.
 *
 * Mirrors {@link setAccount} for amount parsing, CONFIG#defaults payment-account
 * resolution, the shared chargeKey/fallbackChargeKey rule, the `submitCharge`
 * deps ({ getAuthToken, qboServiceUrl, tableName, attachPdf } — the API Lambda now
 * has the processed-bucket read + processing-key decrypt grant, BDK #7) and the
 * submitted/failed state
 * writes. Difference: this path supports arbitrary multi-line input and bypasses
 * the `needsInputType` gate.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME, QBO_SERVICE_URL } from '../constants'
import { getAuthToken } from '../utils/getAuthToken'
import { submitCharge } from '../../shared/booking/submitCharge'
import { attachPdf } from '../utils/attachPdf'
import { chargeKey, fallbackChargeKey } from '../../event-handler/intent/decideBooking'

/** Parses amount strings like "$2,835.09" or "2835.09" into a number. */
const parseAmount = (raw: string | number | undefined): number => {
  if (typeof raw === 'number') return raw
  if (!raw) return 0
  const parsed = parseFloat(String(raw).replace(/[$,]/g, ''))
  return isNaN(parsed) ? 0 : parsed
}

interface QboRef {
  value: string
  name: string
}

interface CorrectLineInput {
  accountRef?: QboRef
  amount?: number | string
  description?: string
}

interface CorrectAndSubmitBody {
  vendorRef?: QboRef
  lines?: CorrectLineInput[]
  documentDate?: string
  memo?: string
  invoiceNumber?: string
  /** When true, book even if a CHARGE# dedup marker already exists. */
  override?: boolean
  /**
   * Optional LIGHT optimistic-concurrency guard. If either is provided and does
   * not match the loaded item, the request is rejected 409 so the client can
   * reload and retry. Backwards-compatible: when both are absent the write
   * proceeds. The heavier generic concurrency work is a separate ticket (#4).
   */
  expectedStatus?: string
  expectedUpdatedAt?: string
}

/** Extracts `{documentId}` from the proxied path (`/expenses/{id}/correct-and-submit`). */
const extractDocumentId = (event: APIGatewayProxyEventV2WithJWTAuthorizer): string | undefined => {
  const fromParams = event.pathParameters?.documentId
  if (fromParams) return fromParams
  // Fallback: parse the raw path (…/expenses/{id}/correct-and-submit).
  const match = event.rawPath?.match(/\/expenses\/([^/]+)\/correct-and-submit$/)
  return match?.[1]
}

export const correctAndSubmit = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  const documentId = extractDocumentId(event)
  if (!documentId) {
    return respond(400, { message: 'documentId path parameter is required' })
  }

  const body = JSON.parse(event.body || '{}') as CorrectAndSubmitBody
  const { vendorRef, lines, documentDate, memo, invoiceNumber, override } = body

  // ─── 1. Load current expense state (404 if absent) ─────────────────────────
  const getResult = await ddbClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `DOC#${documentId}`, sk: 'state' },
    }),
  )

  if (!getResult.Item) {
    return respond(404, { message: 'Expense not found' })
  }

  const expense = getResult.Item

  // ─── Light optimistic-concurrency guard (opt-in, backwards-compatible) ─────
  if (
    (body.expectedStatus !== undefined && body.expectedStatus !== expense.status) ||
    (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== expense.updatedAt)
  ) {
    return respond(409, {
      message: 'Expense changed since it was loaded — reload and retry',
      currentStatus: expense.status,
      currentUpdatedAt: expense.updatedAt,
    })
  }

  // ─── 2. Validate the human-edited payload BEFORE any QBO call ──────────────
  const errors: Array<{ field: string; message: string }> = []

  if (!vendorRef?.value) {
    errors.push({ field: 'vendorRef.value', message: 'Resolved vendor entityRef is required' })
  }
  if (!documentDate) {
    errors.push({ field: 'documentDate', message: 'documentDate is required' })
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    errors.push({ field: 'lines', message: 'At least one line is required' })
  } else {
    lines.forEach((line, i) => {
      const amount = parseAmount(line.amount)
      if (!(amount > 0)) {
        errors.push({
          field: `lines[${i}].amount`,
          message: 'Amount must parse to a positive number',
        })
      }
      if (!line.accountRef?.value) {
        errors.push({
          field: `lines[${i}].accountRef.value`,
          message: 'accountRef.value is required',
        })
      }
    })
  }

  if (errors.length > 0) {
    return respond(400, { message: 'Validation failed', errors })
  }

  // Non-null-safe now that validation passed.
  const validLines = lines as CorrectLineInput[]
  const parsedLines = validLines.map((line) => ({
    amount: parseAmount(line.amount),
    accountRef: line.accountRef as QboRef,
    description:
      line.description ?? `${expense.vendorDisplay || expense.vendorName} - ${documentDate}`,
  }))
  const totalAmount = parsedLines.reduce((sum, line) => sum + line.amount, 0)

  // Resolve the payment account from CONFIG#defaults (500 if missing, mirrors setAccount).
  const configResult = await ddbClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: 'CONFIG#defaults', sk: 'v0' },
    }),
  )
  const paymentAccountRef = configResult.Item?.paymentAccountRef as QboRef | undefined

  if (!paymentAccountRef?.value) {
    return respond(500, {
      message: 'No default payment account configured (CONFIG#defaults.paymentAccountRef missing)',
    })
  }

  // ─── 3. Pre-POST dedup check ───────────────────────────────────────────────
  // Compute the charge key with the shared rule: primary (invoice) key when an
  // invoice number is given/known, else the amount+date fallback. The key must
  // match what the automated event-handler + setAccount would compute.
  const vendorId = (vendorRef as QboRef).value
  const effectiveInvoiceNumber = invoiceNumber ?? (expense.invoiceNumber as string | undefined)
  const bookingChargeKey = effectiveInvoiceNumber
    ? chargeKey(vendorId, effectiveInvoiceNumber)
    : fallbackChargeKey(vendorId, totalAmount, documentDate as string)

  const markerResult = await ddbClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: bookingChargeKey, sk: 'marker' },
    }),
  )

  if (markerResult.Item && override !== true) {
    return respond(409, {
      message: `Looks already booked as purchase ${markerResult.Item.qboPurchaseId}`,
      qboPurchaseId: markerResult.Item.qboPurchaseId,
    })
  }

  // ─── 4. Build the multi-line QBO payload from the human-edited lines ───────
  const docNumber = documentId.slice(0, 21)
  const qboPayload = {
    docNumber,
    txnDate: documentDate,
    paymentType: 'CreditCard',
    paymentAccountRef,
    entityRef: vendorRef,
    lines: parsedLines,
    privateNote:
      memo ||
      `Manual correct & submit: ${expense.description || expense.vendorDisplay || expense.vendorName}`,
  }

  // Source PDF URI persisted on the DOC# state by the event-handler; when present
  // the shared primitive best-effort attaches the receipt to the QBO purchase (BDK #7).
  const originalUri = expense.originalUri as string | undefined

  // ─── 5. Book via the shared primitive (writes the CHARGE# marker + attaches PDF) ─
  try {
    const now = new Date().toISOString()
    const result = await submitCharge(
      {
        qboPayload,
        documentId,
        chargeKey: bookingChargeKey,
        vendorId,
        invoiceNumber: effectiveInvoiceNumber,
        amount: totalAmount,
        documentDate: documentDate as string,
        originalUri,
      },
      ddbClient,
      { getAuthToken, qboServiceUrl: QBO_SERVICE_URL, tableName: TABLE_NAME, attachPdf },
    )

    if (result.success) {
      const purchaseId = result.qboPurchaseId

      // ─── 6. Success state write (clear needsInputType/validationErrors) ────
      await ddbClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `DOC#${documentId}`, sk: 'state' },
          UpdateExpression:
            'SET #status = :status, qboDocNumber = :docNo, qboPurchaseId = :pid, submittedAt = :now, lastAttempt = :now, attempts = if_not_exists(attempts, :zero) + :inc, needsInputType = :nit, validationErrors = :ve, parsedLines = :lines, attachmentUploaded = :au, attachmentFailed = :af, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'submitted',
            ':docNo': result.qboDocNumber ?? docNumber,
            ':pid': purchaseId || '',
            ':now': now,
            ':zero': 0,
            ':inc': 1,
            ':nit': null,
            ':ve': null,
            ':lines': parsedLines,
            ':au': result.attachmentUploaded ?? null,
            ':af': result.attachmentFailed ?? null,
          },
        }),
      )

      // Partial-failure passthrough: the PDF attach is best-effort — an attach
      // failure never rolls back a successful booking (BDK #7).
      return respond(200, {
        message: 'Expense corrected and submitted to QBO',
        purchaseId,
        attachmentFailed: result.attachmentFailed,
      })
    } else {
      await ddbClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `DOC#${documentId}`, sk: 'state' },
          UpdateExpression:
            'SET #status = :status, failedAt = :now, failureReason = :reason, lastAttempt = :now, attempts = if_not_exists(attempts, :zero) + :inc, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'failed',
            ':now': now,
            ':reason': result.error || 'QBO submission failed',
            ':zero': 0,
            ':inc': 1,
          },
        }),
      )

      return respond(502, { message: `QBO submission failed: ${result.error}` })
    }
  } catch (err) {
    console.error('Error correcting and submitting expense:', err)
    return respond(500, { message: 'Failed to correct and submit expense' })
  }
}
