import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME, QBO_SERVICE_URL } from '../constants'
import { getAuthToken } from '../utils/getAuthToken'

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
        const token = await getAuthToken()
        const response = await fetch(`${QBO_SERVICE_URL}/purchases`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(expense.qboPayload),
        })

        if (!response.ok) {
          const errorBody = await response.text()
          throw new Error(`QBO API error ${response.status}: ${errorBody}`)
        }

        const qboResult = (await response.json()) as {
          docNumber?: string
          purchaseId?: string
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
              ':docNumber': qboResult.docNumber || '',
              ':purchaseId': qboResult.purchaseId || '',
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
