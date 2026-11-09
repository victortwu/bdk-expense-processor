import { ScanCommand } from '@aws-sdk/lib-dynamodb'
import { ApiHandler, respond } from '../../shared/http/respond'
import { RULE_PREFIX } from '../../shared/keys'
import { TABLE_NAME } from '../constants'

export const listRules: ApiHandler = async (_event, ddbClient) => {
  try {
    const items: Record<string, unknown>[] = []
    let lastEvaluatedKey: Record<string, unknown> | undefined

    do {
      const result = await ddbClient.send(
        new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'begins_with(pk, :pkPrefix) AND sk = :sk',
          ExpressionAttributeValues: {
            ':pkPrefix': RULE_PREFIX,
            ':sk': 'v0',
          },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      )

      if (result.Items) {
        items.push(...result.Items)
      }
      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined
    } while (lastEvaluatedKey)

    return respond(200, { items, count: items.length })
  } catch (err) {
    console.error('Error listing rules:', err)
    return respond(500, { message: 'Failed to list rules' })
  }
}
