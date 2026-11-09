import { ExpenseStatus } from '../../shared/expense/status'
import { ApiHandler } from '../../shared/http/respond'
import { bulkBook } from '../utils/bulkBook'

export const submitExpenses: ApiHandler = (event, ddb) =>
  bulkBook(event, ddb, { requiredStatus: ExpenseStatus.Ready, verb: 'submit' })
