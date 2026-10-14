import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME, QBO_SERVICE_URL } from '../constants'
import { getAuthToken } from '../utils/getAuthToken'
import { submitCharge } from '../../shared/booking/submitCharge'
import { chargeKey, fallbackChargeKey } from '../../event-handler/intent/decideBooking'

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

  // Compute the dedup charge key with the shared rule so a manual submit writes
  // the SAME marker the automated event-handler would — closing the double-book
  // hole. Primary (invoice) key when an invoice number is on the expense state,
  // else the amount+date fallback. OMIT originalUri: the API Lambda has no
  // processed-bucket grant, so no attachment is attempted (follow-up #7).
  const vendorId = (expense.qboVendorRef as { value?: string } | undefined)?.value ?? ''
  const invoiceNumber = expense.invoiceNumber as string | undefined
  const bookingChargeKey = invoiceNumber
    ? chargeKey(vendorId, invoiceNumber)
    : fallbackChargeKey(vendorId, amount, (expense.documentDate as string) || '')

  // Submit to QBO through the shared booking primitive (authenticated POST +
  // 409-as-success + conditional CHARGE# marker). The API Lambda supplies its
  // own container-cached getAuthToken and no attachPdf (no PDF grant).
  try {
    const now = new Date().toISOString()
    const result = await submitCharge(
      {
        qboPayload,
        documentId,
        chargeKey: bookingChargeKey,
        vendorId,
        invoiceNumber,
        amount,
        documentDate: (expense.documentDate as string) || '',
      },
      ddbClient,
      { getAuthToken, qboServiceUrl: QBO_SERVICE_URL, tableName: TABLE_NAME },
    )

    if (result.success) {
      const purchaseId = result.qboPurchaseId

      await ddbClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `DOC#${documentId}`, sk: 'state' },
          UpdateExpression:
            'SET #status = :status, qboDocNumber = :docNo, qboPurchaseId = :pid, submittedAt = :now, lastAttempt = :now, attempts = attempts + :inc, needsInputType = :nit, validationErrors = :ve, parsedLines = :lines, updatedAt = :now',
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
      await ddbClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `DOC#${documentId}`, sk: 'state' },
          UpdateExpression:
            'SET #status = :status, failedAt = :now, failureReason = :reason, lastAttempt = :now, attempts = attempts + :inc, updatedAt = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'failed',
            ':now': now,
            ':reason': result.error || 'QBO submission failed',
            ':inc': 1,
          },
        }),
      )

      return respond(502, { message: `QBO submission failed: ${result.error}` })
    }
  } catch (err) {
    console.error('Error submitting expense:', err)
    return respond(500, { message: 'Failed to submit expense' })
  }
}
