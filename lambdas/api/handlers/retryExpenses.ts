import { ExpenseStatus } from '../../shared/expense/status'
import { ApiHandler } from '../../shared/http/respond'
import { bulkBook } from '../utils/bulkBook'

export const retryExpenses: ApiHandler = (event, ddb) =>
  bulkBook(event, ddb, { requiredStatus: ExpenseStatus.Failed, verb: 'retry' })
