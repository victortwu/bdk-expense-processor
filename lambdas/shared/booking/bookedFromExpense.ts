import { ExpenseState, QboPayload } from '../expense/types'
import { resolveChargeKey } from '../keys'
import { QboRef } from '../qbo/types'
import { parseAmount } from '../utils/parseAmount'
import { BookedExpense } from './markSubmitted'

/**
 * Booking view of a stored expense whose vendor/amount/date stand as persisted
 * (set-account, bulk submit/retry). The charge key is the one the pipeline stored; for
 * records that predate it, it is derived by the same shared rule from the persisted
 * invoice number / first amount — never from the payload — so every path agrees.
 */
export const bookedFromExpense = (
  expense: ExpenseState & { qboVendorRef: QboRef },
  qboPayload: QboPayload,
): BookedExpense => ({
  vendorRef: expense.qboVendorRef,
  vendorName: expense.vendorName,
  vendorDisplay: expense.vendorDisplay,
  documentDate: expense.documentDate,
  invoiceNumber: expense.invoiceNumber,
  chargeKey:
    expense.chargeKey ??
    resolveChargeKey({
      vendorId: expense.qboVendorRef.value,
      invoiceNumber: expense.invoiceNumber,
      amount: parseAmount(expense.amounts[0]),
      documentDate: expense.documentDate,
    }),
  amounts: expense.amounts,
  parsedLines: qboPayload.lines,
  qboPayload,
})
