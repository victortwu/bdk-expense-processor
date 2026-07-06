import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { TABLE_NAME, QBO_SERVICE_URL } from '../constants'

export const approveVendor = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  ddbClient: DynamoDBDocumentClient,
) => {
  const body = JSON.parse(event.body || '{}')
  const { documentId, vendorName } = body as { documentId: string; vendorName: string }

  if (!documentId || !vendorName) {
    return respond(400, { message: 'documentId and vendorName are required' })
  }

  // Get current expense state
  const getResult = await ddbClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `DOC#${documentId}`, sk: 'state' },
    }),
  )

  if (!getResult.Item) {
    return respond(404, { message: 'Expense not found' })
  }

  if (getResult.Item.needsInputType !== 'new_vendor') {
    return respond(400, { message: `Expense is not awaiting vendor approval (current: ${getResult.Item.needsInputType})` })
  }

  // Create vendor in QBO
  try {
    const createResponse = await fetch(`${QBO_SERVICE_URL}/vendors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: vendorName, companyName: vendorName }),
    })

    if (!createResponse.ok) {
      const errorBody = await createResponse.text()
      return respond(502, { message: `Failed to create vendor in QBO: ${errorBody}` })
    }

    const newVendor = (await createResponse.json()) as { id: string; displayName: string }

    // Update expense state to pending re-processing
    const now = new Date().toISOString()
    await ddbClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `DOC#${documentId}`, sk: 'state' },
        UpdateExpression: 'SET #status = :status, qboVendorRef = :vendorRef, needsInputType = :nit, validationErrors = :ve, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'pending_validation',
          ':vendorRef': { value: newVendor.id, name: newVendor.displayName },
          ':nit': null,
          ':ve': null,
          ':now': now,
        },
      }),
    )

    // Invalidate vendor cache so next processing picks up the new vendor
    await ddbClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'CACHE#qbo-vendors', sk: 'v0' },
        UpdateExpression: 'SET refreshedAt = :stale',
        ExpressionAttributeValues: { ':stale': '2000-01-01T00:00:00.000Z' },
      }),
    ).catch(() => { /* cache might not exist yet */ })

    return respond(200, {
      message: 'Vendor created in QBO. Document will be re-processed on next event.',
      vendor: newVendor,
    })
  } catch (err) {
    console.error('Error creating vendor:', err)
    return respond(500, { message: 'Failed to create vendor' })
  }
}
