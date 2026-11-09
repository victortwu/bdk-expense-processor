import { ScanCommand } from '@aws-sdk/lib-dynamodb'
import { STATS_STATUSES } from '../../shared/expense/status'
import { ApiHandler, respond } from '../../shared/http/respond'
import { DOC_PREFIX } from '../../shared/keys'
import { TABLE_NAME } from '../constants'

export const getStats: ApiHandler = async (_event, ddbClient) => {
  try {
    const stats: Record<string, number> = { total: 0 }
    for (const status of STATS_STATUSES) stats[status] = 0

    let lastEvaluatedKey: Record<string, unknown> | undefined

    do {
      const result = await ddbClient.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'begins_with(pk, :pkPrefix) AND sk = :sk',
          ExpressionAttributeValues: {
            ':pkPrefix': DOC_PREFIX,
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
          const status = item.status as string
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
