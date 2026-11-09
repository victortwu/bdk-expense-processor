import { expenseRepo } from '../../shared/expense/expenseRepo'
import { ExpenseStatus } from '../../shared/expense/status'
import { ApiError, ApiHandler, parseJsonBody, respond } from '../../shared/http/respond'
import { TABLE_NAME } from '../constants'

export const skipExpenses: ApiHandler = async (event, ddb) => {
  const { documentIds } = parseJsonBody<{ documentIds?: string[] }>(event)
  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    throw new ApiError(400, 'documentIds array is required')
  }

  const repo = expenseRepo(ddb, TABLE_NAME)
  const results: { documentId: string; success: boolean; error?: string }[] = []

  for (const documentId of documentIds) {
    try {
      // A submitted expense is booked in QBO — skipping it would hide that from the dashboard.
      const skipped = await repo.transition(documentId, {
        notFrom: [ExpenseStatus.Submitted],
        to: ExpenseStatus.Skipped,
      })
      if (skipped) {
        results.push({ documentId, success: true })
      } else {
        const existing = await repo.get(documentId)
        results.push({
          documentId,
          success: false,
          error: existing
            ? `Cannot skip expense with status: ${existing.status}`
            : 'Expense not found',
        })
      }
    } catch (err) {
      console.error(`Error skipping expense ${documentId}:`, err)
      results.push({
        documentId,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  const skipped = results.filter((r) => r.success).length
  return respond(200, { skipped, failed: results.length - skipped, results })
}
