import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME } from '../constants'

export const getExpense = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  const documentId = event.pathParameters?.documentId

  if (!documentId) {
    return respond(400, { message: 'documentId path parameter is required' })
  }

  try {
    const result = await ddbClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DOC#${documentId}`, sk: 'state' },
      }),
    )

    if (!result.Item) {
      return respond(404, { message: `Expense not found: ${documentId}` })
    }

    return respond(200, result.Item)
  } catch (err) {
    console.error('Error getting expense:', err)
    return respond(500, { message: 'Failed to get expense' })
  }
}
