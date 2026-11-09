import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { bookExpense } from '../../shared/booking/bookExpense'
import { bookedFromExpense } from '../../shared/booking/bookedFromExpense'
import { getBookingDeps } from '../../shared/booking/bookingDeps'
import { expenseRepo } from '../../shared/expense/expenseRepo'
import { ExpenseStatus } from '../../shared/expense/status'
import { ApiError, ApiEvent, parseJsonBody, respond } from '../../shared/http/respond'
import { TABLE_NAME } from '../constants'
import { bookFailureMessage } from './respondToBookOutcome'

/**
 * Bulk submit/retry: books each expense currently in `requiredStatus` from its persisted
 * `qboPayload` through the shared `bookExpense` path. Per-document failures never abort the batch.
 */
export const bulkBook = async (
  event: ApiEvent,
  ddb: DynamoDBDocumentClient,
  { requiredStatus, verb }: { requiredStatus: ExpenseStatus; verb: 'submit' | 'retry' },
) => {
  const { documentIds } = parseJsonBody<{ documentIds?: string[] }>(event)
  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    throw new ApiError(400, 'documentIds array is required')
  }

  const repo = expenseRepo(ddb, TABLE_NAME)
  const deps = getBookingDeps()
  const results: { documentId: string; success: boolean; error?: string }[] = []

  for (const documentId of documentIds) {
    const fail = (error: string) => results.push({ documentId, success: false, error })
    try {
      const expense = await repo.get(documentId)
      if (!expense) {
        fail('Expense not found')
      } else if (expense.status !== requiredStatus) {
        fail(`Cannot ${verb} expense with status: ${expense.status}`)
      } else if (!expense.qboPayload || !expense.qboVendorRef) {
        fail('No QBO payload available')
      } else {
        const outcome = await bookExpense(
          {
            documentId,
            status: expense.status,
            booked: bookedFromExpense(
              { ...expense, qboVendorRef: expense.qboVendorRef },
              expense.qboPayload,
            ),
            originalUri: expense.originalUri,
          },
          ddb,
          deps,
        )
        if (outcome.kind === 'submitted') results.push({ documentId, success: true })
        else fail(bookFailureMessage(outcome))
      }
    } catch (err) {
      console.error(`Error processing expense ${documentId}:`, err)
      fail(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  const submitted = results.filter((r) => r.success).length
  return respond(200, { submitted, failed: results.length - submitted, results })
}
