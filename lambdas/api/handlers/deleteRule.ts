import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME } from '../constants'

export const deleteRule = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  const vendorName = event.pathParameters?.vendorName

  if (!vendorName) {
    return respond(400, { message: 'vendorName path parameter is required' })
  }

  try {
    await ddbClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: `RULE#${vendorName}`, sk: 'v0' },
        ConditionExpression: 'attribute_exists(pk)',
      }),
    )

    return respond(200, { message: `Rule deleted: ${vendorName}` })
  } catch (err: unknown) {
    const error = err as { name?: string }
    if (error.name === 'ConditionalCheckFailedException') {
      return respond(404, { message: `Rule not found: ${vendorName}` })
    }
    console.error('Error deleting rule:', err)
    return respond(500, { message: 'Failed to delete rule' })
  }
}
