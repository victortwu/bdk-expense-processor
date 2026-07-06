import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME } from '../constants'

export const listExpenses = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  const status = event.queryStringParameters?.status
  const limit = parseInt(event.queryStringParameters?.limit || '50', 10)
  const nextToken = event.queryStringParameters?.nextToken

  try {
    const params: Record<string, unknown> = {
      TableName: TABLE_NAME,
      IndexName: 'ByStatus',
      KeyConditionExpression: status
        ? '#status = :status'
        : 'begins_with(pk, :pkPrefix)',
      ExpressionAttributeValues: status
        ? { ':status': status }
        : { ':pkPrefix': 'DOC#' },
      Limit: limit,
    }

    if (status) {
      params.ExpressionAttributeNames = { '#status': 'status' }
    }

    if (nextToken) {
      params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString())
    }

    const result = await ddbClient.send(new QueryCommand(params as any))

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
