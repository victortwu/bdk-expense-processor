import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME, QBO_SERVICE_URL } from '../constants'
import { getAuthToken } from '../utils/getAuthToken'
import { submitCharge } from '../../shared/booking/submitCharge'
import { chargeKey, fallbackChargeKey } from '../../event-handler/intent/decideBooking'

/** Parses amount strings like "$2,835.09" or "2835.09" into a number. */
const parseAmount = (raw: unknown): number => {
  if (typeof raw === 'number') return raw
  if (!raw) return 0
  const parsed = parseFloat(String(raw).replace(/[$,]/g, ''))
  return isNaN(parsed) ? 0 : parsed
}

/**
 * Compute the dedup charge key for a replayed expense with the shared rule, so
 * a manual retry writes the SAME marker the automated path would. Primary
 * (invoice) key when an invoice number is recoverable from the expense state,
 * else the amount+date fallback derived from the prebuilt QBO payload.
 */
const resolveChargeKey = (expense: Record<string, unknown>): { key: string; vendorId: string; invoiceNumber?: string; amount: number; documentDate: string } => {
  const vendorId = (expense.qboVendorRef as { value?: string } | undefined)?.value ?? ''
  const invoiceNumber = expense.invoiceNumber as string | undefined
  const payload = expense.qboPayload as { txnDate?: string; lines?: { amount?: number }[] } | undefined
  const documentDate = payload?.txnDate ?? (expense.documentDate as string) ?? ''
  const amount = payload?.lines?.[0]?.amount ?? parseAmount((expense.amounts as unknown[] | undefined)?.[0])
  const key = invoiceNumber
    ? chargeKey(vendorId, invoiceNumber)
    : fallbackChargeKey(vendorId, amount, documentDate)
  return { key, vendorId, invoiceNumber, amount, documentDate }
}

export const retryExpenses = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  const body = JSON.parse(event.body || '{}')
  const { documentIds } = body as { documentIds: string[] }

  if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
    return respond(400, { message: 'documentIds array is required' })
  }

  const results: { documentId: string; success: boolean; error?: string }[] = []
  let submitted = 0
  let failed = 0

  for (const documentId of documentIds) {
    try {
      const getResult = await ddbClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: `DOC#${documentId}`, sk: 'state' },
        }),
      )

      if (!getResult.Item) {
        results.push({ documentId, success: false, error: 'Expense not found' })
        failed++
        continue
      }

      const expense = getResult.Item

      if (expense.status !== 'failed') {
        results.push({
          documentId,
          success: false,
          error: `Cannot retry expense with status: ${expense.status}`,
        })
        failed++
        continue
      }

      if (!expense.qboPayload) {
        results.push({ documentId, success: false, error: 'No QBO payload available' })
        failed++
        continue
      }

      const now = new Date().toISOString()

      try {
        const ck = resolveChargeKey(expense)
        const result = await submitCharge(
          {
            qboPayload: expense.qboPayload,
            documentId,
            chargeKey: ck.key,
            vendorId: ck.vendorId,
            invoiceNumber: ck.invoiceNumber,
            amount: ck.amount,
            documentDate: ck.documentDate,
          },
          ddbClient,
          { getAuthToken, qboServiceUrl: QBO_SERVICE_URL, tableName: TABLE_NAME },
        )

        if (!result.success) {
          throw new Error(result.error || 'QBO submission failed')
        }

        await ddbClient.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: `DOC#${documentId}`, sk: 'state' },
            UpdateExpression:
              'SET #status = :status, qboDocNumber = :docNumber, qboPurchaseId = :purchaseId, submittedAt = :now, lastAttempt = :now, attempts = attempts + :inc, updatedAt = :now REMOVE failureReason, failedAt',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': 'submitted',
              ':docNumber': result.qboDocNumber || '',
              ':purchaseId': result.qboPurchaseId || '',
              ':now': now,
              ':inc': 1,
            },
          }),
        )

        results.push({ documentId, success: true })
        submitted++
      } catch (qboErr) {
        const errorMessage = qboErr instanceof Error ? qboErr.message : 'Unknown QBO error'

        await ddbClient.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: `DOC#${documentId}`, sk: 'state' },
            UpdateExpression:
              'SET failedAt = :now, failureReason = :reason, lastAttempt = :now, attempts = attempts + :inc, updatedAt = :now',
            ExpressionAttributeValues: {
              ':now': now,
              ':reason': errorMessage,
              ':inc': 1,
            },
          }),
        )

        results.push({ documentId, success: false, error: errorMessage })
        failed++
      }
    } catch (err) {
      console.error(`Error retrying expense ${documentId}:`, err)
      results.push({
        documentId,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
      failed++
    }
  }

  return respond(200, { submitted, failed, results })
}
