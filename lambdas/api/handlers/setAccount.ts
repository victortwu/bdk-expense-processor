import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME, QBO_SERVICE_URL } from '../constants'
import { getAuthToken } from '../utils/getAuthToken'

/** Parses amount strings like "$2,835.09" or "2835.09" into a number. */
const parseAmount = (raw: string | number | undefined): number => {
  if (typeof raw === 'number') return raw
  if (!raw) return 0
  const parsed = parseFloat(String(raw).replace(/[$,]/g, ''))
  return isNaN(parsed) ? 0 : parsed
}

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

  // Resolve the payment account from CONFIG#defaults (fall back to the record's
  // own ref if present). Previously this was hardcoded to a placeholder account,
  // which caused QBO to reject the purchase.
  const configResult = await ddbClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: 'CONFIG#defaults', sk: 'v0' },
    }),
  )
  const paymentAccountRef = configResult.Item?.paymentAccountRef as
    | { value: string; name: string }
    | undefined

  if (!paymentAccountRef?.value) {
    return respond(500, {
      message: 'No default payment account configured (CONFIG#defaults.paymentAccountRef missing)',
    })
  }

  // Build QBO payload with the selected account. Amounts are stored as raw
  // extracted strings (e.g. "$1,234.56") — parse before sending to QBO.
  const amount = parseAmount(expense.amounts?.[0] as string | number | undefined)

  if (amount <= 0) {
    return respond(400, {
      message: 'No valid positive amount on this expense to submit',
    })
  }

  const qboPayload = {
    docNumber: (expense.documentId as string).slice(0, 21),
    txnDate: expense.documentDate,
    paymentType: 'CreditCard',
    paymentAccountRef,
    entityRef: expense.qboVendorRef,
    lines: [{
      amount,
      accountRef,
      description: `${expense.vendorDisplay || expense.vendorName} - ${expense.documentDate}`,
    }],
    privateNote: `Manual account selection: ${expense.description || expense.vendorDisplay}`,
  }

  // Submit to QBO (authenticated M2M call — the QBO Service /purchases route is
  // JWT-protected; without a Bearer token this returns 401).
  try {
    const token = await getAuthToken()
    const response = await fetch(`${QBO_SERVICE_URL}/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
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
