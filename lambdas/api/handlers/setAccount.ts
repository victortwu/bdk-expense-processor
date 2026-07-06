import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME, QBO_SERVICE_URL } from '../constants'

export const setAccount = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  const body = JSON.parse(event.body || '{}')
  const { documentId, accountRef } = body as {
    documentId: string
    accountRef: { value: string; name: string }
  }

  if (!documentId || !accountRef?.value || !accountRef?.name) {
    return respond(400, { message: 'documentId and accountRef (with value and name) are required' })
  }

  // Get current expense state
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

  if (expense.needsInputType !== 'pick_expense_account') {
    return respond(400, { message: `Expense is not awaiting account selection (current: ${expense.needsInputType})` })
  }

  // Build QBO payload with the selected account
  const amount = expense.amounts?.[0] || 0
  const qboPayload = {
    docNumber: (expense.documentId as string).slice(0, 21),
    txnDate: expense.documentDate,
    paymentType: 'CreditCard',
    paymentAccountRef: { value: '1', name: 'Default Credit Card' }, // TODO: read from CONFIG#defaults
    entityRef: expense.qboVendorRef,
    lines: [{
      amount,
      accountRef,
      description: `${expense.vendorDisplay || expense.vendorName} - ${expense.documentDate}`,
    }],
    privateNote: `Manual account selection: ${expense.description || expense.vendorDisplay}`,
  }

  // Submit to QBO
  try {
    const response = await fetch(`${QBO_SERVICE_URL}/purchases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(qboPayload),
    })

    const now = new Date().toISOString()

    if (response.ok || response.status === 409) {
      const data = (await response.json()) as { id?: string; docNumber?: string; existing?: { id?: string } }
      const purchaseId = data.id || data.existing?.id

      await ddbClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `DOC#${documentId}`, sk: 'state' },
          UpdateExpression: 'SET #status = :status, qboDocNumber = :docNo, qboPurchaseId = :pid, submittedAt = :now, lastAttempt = :now, attempts = attempts + :inc, needsInputType = :nit, validationErrors = :ve, parsedLines = :lines, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'submitted',
            ':docNo': qboPayload.docNumber,
            ':pid': purchaseId || '',
            ':now': now,
            ':inc': 1,
            ':nit': null,
            ':ve': null,
            ':lines': qboPayload.lines,
          },
        }),
      )

      return respond(200, { message: 'Expense submitted to QBO', purchaseId })
    } else {
      const errorBody = await response.text()

      await ddbClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `DOC#${documentId}`, sk: 'state' },
          UpdateExpression: 'SET #status = :status, failedAt = :now, failureReason = :reason, lastAttempt = :now, attempts = attempts + :inc, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'failed',
            ':now': now,
            ':reason': `QBO error ${response.status}: ${errorBody}`,
            ':inc': 1,
          },
        }),
      )

      return respond(502, { message: `QBO submission failed: ${errorBody}` })
    }
  } catch (err) {
    console.error('Error submitting expense:', err)
    return respond(500, { message: 'Failed to submit expense' })
  }
}
