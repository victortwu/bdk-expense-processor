import { bookExpense } from '../../shared/booking/bookExpense'
import { bookedFromExpense } from '../../shared/booking/bookedFromExpense'
import { getBookingDeps } from '../../shared/booking/bookingDeps'
import { buildQboPayload } from '../../shared/booking/buildQboPayload'
import { expenseRepo } from '../../shared/expense/expenseRepo'
import { getPaymentAccountRef } from '../../shared/expense/getPaymentAccountRef'
import { ApiHandler, parseJsonBody, respond } from '../../shared/http/respond'
import { QboRef } from '../../shared/qbo/types'
import { parseAmount } from '../../shared/utils/parseAmount'
import { TABLE_NAME } from '../constants'
import { respondToBookOutcome } from '../utils/respondToBookOutcome'

/** POST /expenses/set-account — a human picks the expense account; book as a single line. */
export const setAccount: ApiHandler = async (event, ddb) => {
  const { documentId, accountRef } = parseJsonBody<{ documentId?: string; accountRef?: QboRef }>(
    event,
  )

  if (!documentId || !accountRef?.value || !accountRef?.name) {
    return respond(400, { message: 'documentId and accountRef (with value and name) are required' })
  }

  const expense = await expenseRepo(ddb, TABLE_NAME).get(documentId)
  if (!expense) {
    return respond(404, { message: 'Expense not found' })
  }

  if (expense.needsInputType !== 'pick_expense_account') {
    return respond(400, {
      message: `Expense is not awaiting account selection (current: ${expense.needsInputType})`,
    })
  }
  if (!expense.qboVendorRef) {
    return respond(400, { message: 'Expense has no resolved QBO vendor' })
  }

  const paymentAccountRef = await getPaymentAccountRef(ddb, TABLE_NAME)
  if (!paymentAccountRef) {
    return respond(500, {
      message: 'No default payment account configured (CONFIG#defaults.paymentAccountRef missing)',
    })
  }

  // Amounts are stored as raw extracted strings (e.g. "$1,234.56").
  const amount = parseAmount(expense.amounts[0])
  if (amount <= 0) {
    return respond(400, { message: 'No valid positive amount on this expense to submit' })
  }

  const qboPayload = buildQboPayload({
    documentId,
    documentDate: expense.documentDate,
    paymentAccountRef,
    vendorRef: expense.qboVendorRef,
    lines: [
      {
        amount,
        accountRef,
        description: `${expense.vendorDisplay || expense.vendorName} - ${expense.documentDate}`,
      },
    ],
    privateNote: `Manual account selection: ${expense.description || expense.vendorDisplay}`,
  })

  try {
    const outcome = await bookExpense(
      {
        documentId,
        status: expense.status,
        booked: bookedFromExpense({ ...expense, qboVendorRef: expense.qboVendorRef }, qboPayload),
        originalUri: expense.originalUri,
      },
      ddb,
      getBookingDeps(),
    )
    return respondToBookOutcome(outcome, 'Expense submitted to QBO', expense.qboPurchaseId)
  } catch (err) {
    console.error('Error submitting expense:', err)
    return respond(500, { message: 'Failed to submit expense' })
  }
}
