import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME } from '../constants'

export const putRule = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  const vendorName = event.pathParameters?.vendorName

  if (!vendorName) {
    return respond(400, { message: 'vendorName path parameter is required' })
  }

  const body = JSON.parse(event.body || '{}')

  if (!body.ruleType) {
    return respond(400, { message: 'ruleType is required' })
  }

  if (!body.qboVendorRef || !body.qboVendorRef.value || !body.qboVendorRef.name) {
    return respond(400, { message: 'qboVendorRef with value and name is required' })
  }

  const now = new Date().toISOString()

  try {
    const item = {
      pk: `RULE#${vendorName}`,
      sk: 'v0',
      vendorName,
      ruleType: body.ruleType,
      config: body.config || {},
      qboVendorRef: body.qboVendorRef,
      qboPaymentType: body.qboPaymentType,
      qboPaymentAccountRef: body.qboPaymentAccountRef,
      defaultExpenseAccountRef: body.defaultExpenseAccountRef,
      autoSubmit: body.autoSubmit,
      updatedAt: now,
      createdAt: body.createdAt || now,
    }

    await ddbClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      }),
    )

    return respond(200, item)
  } catch (err) {
    console.error('Error putting rule:', err)
    return respond(500, { message: 'Failed to save rule' })
  }
}
