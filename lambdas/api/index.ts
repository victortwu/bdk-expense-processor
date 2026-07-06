import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { respond } from '../shared/utils/respond'
import { listExpenses } from './handlers/listExpenses'
import { getExpense } from './handlers/getExpense'
import { submitExpenses } from './handlers/submitExpenses'
import { retryExpenses } from './handlers/retryExpenses'
import { skipExpenses } from './handlers/skipExpenses'
import { approveVendor } from './handlers/approveVendor'
import { setAccount } from './handlers/setAccount'
import { listRules } from './handlers/listRules'
import { putRule } from './handlers/putRule'
import { deleteRule } from './handlers/deleteRule'
import { getStats } from './handlers/getStats'

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const method = event.requestContext.http.method
  const path = event.rawPath

  try {
    // GET /expenses
    if (method === 'GET' && path === '/expenses') {
      return listExpenses(event, ddbClient)
    }

    // GET /expenses/{documentId}
    if (method === 'GET' && path.startsWith('/expenses/') && !path.includes('/submit') && !path.includes('/retry') && !path.includes('/skip') && !path.includes('/approve-vendor') && !path.includes('/set-account')) {
      return getExpense(event, ddbClient)
    }

    // POST /expenses/submit
    if (method === 'POST' && path === '/expenses/submit') {
      return submitExpenses(event, ddbClient)
    }

    // POST /expenses/retry
    if (method === 'POST' && path === '/expenses/retry') {
      return retryExpenses(event, ddbClient)
    }

    // POST /expenses/skip
    if (method === 'POST' && path === '/expenses/skip') {
      return skipExpenses(event, ddbClient)
    }

    // POST /expenses/approve-vendor
    if (method === 'POST' && path === '/expenses/approve-vendor') {
      return approveVendor(event, ddbClient)
    }

    // POST /expenses/set-account
    if (method === 'POST' && path === '/expenses/set-account') {
      return setAccount(event, ddbClient)
    }

    // GET /rules
    if (method === 'GET' && path === '/rules') {
      return listRules(event, ddbClient)
    }

    // PUT /rules/{vendorName}
    if (method === 'PUT' && path.startsWith('/rules/')) {
      return putRule(event, ddbClient)
    }

    // DELETE /rules/{vendorName}
    if (method === 'DELETE' && path.startsWith('/rules/')) {
      return deleteRule(event, ddbClient)
    }

    // GET /stats
    if (method === 'GET' && path === '/stats') {
      return getStats(event, ddbClient)
    }

    return respond(404, { message: `Route not found: ${method} ${path}` })
  } catch (err) {
    console.error('Unhandled error:', err)
    return respond(500, { message: 'Internal server error' })
  }
}
