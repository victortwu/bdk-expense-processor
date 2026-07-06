import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME } from '../constants'

export const getStats = async (
  _event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  try {
    const stats = {
      ready: 0,
      needs_input: 0,
      submitted: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    }

    let lastEvaluatedKey: Record<string, unknown> | undefined

    do {
      const result = await ddbClient.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'begins_with(pk, :pkPrefix) AND sk = :sk',
          ExpressionAttributeValues: {
            ':pkPrefix': 'DOC#',
            ':sk': 'state',
          },
          ProjectionExpression: '#status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      )

      if (result.Items) {
        for (const item of result.Items) {
          stats.total++
          const status = item.status as keyof typeof stats
          if (status in stats && status !== 'total') {
            stats[status]++
          }
        }
      }

      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined
    } while (lastEvaluatedKey)

    return respond(200, stats)
  } catch (err) {
    console.error('Error getting stats:', err)
    return respond(500, { message: 'Failed to get stats' })
  }
}
