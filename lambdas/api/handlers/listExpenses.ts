import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { ApiHandler, respond } from '../../shared/http/respond'
import { DOC_PREFIX } from '../../shared/keys'
import { TABLE_NAME } from '../constants'

export const listExpenses: ApiHandler = async (event, ddbClient) => {
  const status = event.queryStringParameters?.status
  const limit = parseInt(event.queryStringParameters?.limit || '50', 10)
  const nextToken = event.queryStringParameters?.nextToken

  try {
    const startKey = nextToken
      ? JSON.parse(Buffer.from(nextToken, 'base64').toString())
      : undefined

    const result = status
      ? await ddbClient.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: 'ByStatus',
            KeyConditionExpression: '#status = :status',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':status': status },
            ScanIndexForward: false,
            Limit: limit,
            ExclusiveStartKey: startKey,
          }),
        )
      : await ddbClient.send(
          new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'begins_with(pk, :pkPrefix) AND sk = :sk',
            ExpressionAttributeValues: { ':pkPrefix': DOC_PREFIX, ':sk': 'state' },
            Limit: limit,
            ExclusiveStartKey: startKey,
          }),
        )

    const response: Record<string, unknown> = {
      items: result.Items || [],
      count: result.Count || 0,
    }

    if (result.LastEvaluatedKey) {
      response.nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    }

    return respond(200, response)
  } catch (err) {
    console.error('Error listing expenses:', err)
    return respond(500, { message: 'Failed to list expenses' })
  }
}
