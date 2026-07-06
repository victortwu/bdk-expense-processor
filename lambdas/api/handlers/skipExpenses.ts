import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME } from '../constants'

export const skipExpenses = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  const body = JSON.parse(event.body || '{}')
  const { documentIds } = body as { documentIds: string[] }

  if (!documentIds || !Array.isArray(documentIds) || documentIds.length === 0) {
    return respond(400, { message: 'documentIds array is required' })
  }

  const results: { documentId: string; success: boolean; error?: string }[] = []
  let skipped = 0
  let failed = 0

  for (const documentId of documentIds) {
    try {
      const now = new Date().toISOString()

      await ddbClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `DOC#${documentId}`, sk: 'state' },
          UpdateExpression: 'SET #status = :status, updatedAt = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'skipped',
            ':now': now,
          },
        }),
      )

      results.push({ documentId, success: true })
      skipped++
    } catch (err: unknown) {
      const error = err as { name?: string }
      if (error.name === 'ConditionalCheckFailedException') {
        results.push({ documentId, success: false, error: 'Expense not found' })
      } else {
        console.error(`Error skipping expense ${documentId}:`, err)
        results.push({
          documentId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
      failed++
    }
  }

  return respond(200, { skipped, failed, results })
}
