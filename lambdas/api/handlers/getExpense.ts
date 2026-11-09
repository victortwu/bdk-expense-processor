import { expenseRepo } from '../../shared/expense/expenseRepo'
import { ApiHandler, respond } from '../../shared/http/respond'
import { TABLE_NAME } from '../constants'

export const getExpense: ApiHandler = async (event, ddbClient) => {
  const documentId = event.pathParameters?.documentId

  if (!documentId) {
    return respond(400, { message: 'documentId path parameter is required' })
  }

  try {
    const expense = await expenseRepo(ddbClient, TABLE_NAME).get(documentId)

    if (!expense) {
      return respond(404, { message: `Expense not found: ${documentId}` })
    }

    return respond(200, expense)
  } catch (err) {
    console.error('Error getting expense:', err)
    return respond(500, { message: 'Failed to get expense' })
  }
}
