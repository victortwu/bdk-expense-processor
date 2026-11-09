/**
 * PATH B — direct correct & submit (BDK frontend #3)
 * ────────────────────────────────────────────────────────────────────────────
 * `POST /expenses/{documentId}/correct-and-submit`
 *
 * Lets a HUMAN book a corrected expense DIRECTLY to QuickBooks Online, bypassing the
 * automated intent gate — the human is the booking authority. The handler loads the
 * expense (404), gates skipped/submitted rebooks behind `override` (409), validates the
 * edited payload BEFORE any QBO call (400 w/ field errors), builds a multi-line payload and
 * books it through the shared `bookExpense` path (marker pre-check 409 unless `override`,
 * CHARGE# marker, PDF attach, DOC# state mirroring exactly what was booked).
 *
 * A QBO error body with code `QBO_AUTH_EXPIRED` returns an actionable `QBO_AUTH_EXPIRED`
 * instead of a generic 502 (BDK #6).
 */
import { bookExpense, bookRefusal } from '../../shared/booking/bookExpense'
import { getBookingDeps } from '../../shared/booking/bookingDeps'
import { buildQboPayload } from '../../shared/booking/buildQboPayload'
import { expenseRepo } from '../../shared/expense/expenseRepo'
import { getPaymentAccountRef } from '../../shared/expense/getPaymentAccountRef'
import { ParsedLine } from '../../shared/expense/types'
import { ApiHandler, parseJsonBody, respond } from '../../shared/http/respond'
import { resolveChargeKey } from '../../shared/keys'
import { QboRef } from '../../shared/qbo/types'
import { AmountInput, parseAmount } from '../../shared/utils/parseAmount'
import { TABLE_NAME } from '../constants'
import { respondToBookOutcome } from '../utils/respondToBookOutcome'

interface CorrectLineInput {
  accountRef?: QboRef
  amount?: AmountInput
  description?: string
}

interface CorrectAndSubmitBody {
  vendorRef?: QboRef
  lines?: CorrectLineInput[]
  documentDate?: string
  memo?: string
  invoiceNumber?: string
  /** When true, book even if a CHARGE# marker exists or the expense is submitted/skipped. */
  override?: boolean
  /**
   * Optional LIGHT optimistic-concurrency guard. If either is provided and does not match the
   * loaded item, the request is rejected 409 so the client can reload and retry.
   */
  expectedStatus?: string
  expectedUpdatedAt?: string
}

export const correctAndSubmit: ApiHandler = async (event, ddb) => {
  const documentId = event.pathParameters?.documentId
  if (!documentId) {
    return respond(400, { message: 'documentId path parameter is required' })
  }

  const body = parseJsonBody<CorrectAndSubmitBody>(event)
  const { vendorRef, lines, documentDate, memo, invoiceNumber, override } = body

  const expense = await expenseRepo(ddb, TABLE_NAME).get(documentId)
  if (!expense) {
    return respond(404, { message: 'Expense not found' })
  }

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

  // Un-skip / rebook gate — fail fast, before validation.
  const refusal = bookRefusal(expense.status, override)
  if (refusal) {
    return respondToBookOutcome({ kind: 'refused', reason: refusal }, '', expense.qboPurchaseId)
  }

  // ─── Validate the human-edited payload BEFORE any QBO call ─────────────────
  const errors: Array<{ field: string; message: string }> = []

  if (!vendorRef?.value) {
    errors.push({ field: 'vendorRef.value', message: 'Resolved vendor entityRef is required' })
  } else if (!vendorRef.name) {
    errors.push({ field: 'vendorRef.name', message: 'Vendor name is required' })
  }
  if (!documentDate) {
    errors.push({ field: 'documentDate', message: 'documentDate is required' })
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    errors.push({ field: 'lines', message: 'At least one line is required' })
  } else {
    lines.forEach((line, i) => {
      if (!(parseAmount(line.amount) > 0)) {
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

  if (errors.length > 0 || !vendorRef || !documentDate || !lines) {
    return respond(400, { message: 'Validation failed', errors })
  }

  const parsedLines: ParsedLine[] = lines.map((line) => ({
    amount: parseAmount(line.amount),
    accountRef: line.accountRef as QboRef,
    description:
      line.description ?? `${expense.vendorDisplay || expense.vendorName} - ${documentDate}`,
  }))
  const totalAmount = parsedLines.reduce((sum, line) => sum + line.amount, 0)

  const paymentAccountRef = await getPaymentAccountRef(ddb, TABLE_NAME)
  if (!paymentAccountRef) {
    return respond(500, {
      message: 'No default payment account configured (CONFIG#defaults.paymentAccountRef missing)',
    })
  }

  // The vendor/amount may have been corrected, so the charge key is recomputed (shared rule).
  // An explicit empty string clears a wrongly extracted number; omitted keeps the stored one.
  const effectiveInvoiceNumber =
    invoiceNumber === undefined ? expense.invoiceNumber : invoiceNumber.trim() || undefined
  const qboPayload = buildQboPayload({
    documentId,
    documentDate,
    paymentAccountRef,
    vendorRef,
    lines: parsedLines,
    privateNote:
      memo ||
      `Manual correct & submit: ${expense.description || expense.vendorDisplay || expense.vendorName}`,
  })

  try {
    const outcome = await bookExpense(
      {
        documentId,
        status: expense.status,
        override,
        originalUri: expense.originalUri,
        booked: {
          vendorRef,
          // The state must reflect what was actually booked (the human's corrections).
          vendorName: vendorRef.name,
          vendorDisplay: vendorRef.name,
          documentDate,
          invoiceNumber: effectiveInvoiceNumber,
          chargeKey: resolveChargeKey({
            vendorId: vendorRef.value,
            invoiceNumber: effectiveInvoiceNumber,
            amount: totalAmount,
            documentDate,
          }),
          amounts: [totalAmount],
          parsedLines,
          qboPayload,
        },
      },
      ddb,
      getBookingDeps(),
    )
    return respondToBookOutcome(
      outcome,
      'Expense corrected and submitted to QBO',
      expense.qboPurchaseId,
    )
  } catch (err) {
    console.error('Error correcting and submitting expense:', err)
    return respond(500, { message: 'Failed to correct and submit expense' })
  }
}
