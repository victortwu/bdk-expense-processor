/**
 * approveVendor handler tests — creates a QBO vendor for a `new_vendor` expense.
 * Covers: success (Bearer token sent), duplicate-vendor (409) adoption, QBO 401,
 * 404 expense, wrong needsInputType.
 *
 * Mocks DynamoDB (aws-sdk-client-mock), getAuthToken (jest.mock), global.fetch.
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'

jest.mock('../../lambdas/shared/auth/getAuthToken', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-token'),
}))

import { approveVendor } from '../../lambdas/api/handlers/approveVendor'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const DOC_ID = '01TESTDOC0000000000000000'
const STATE_KEY = { pk: `DOC#${DOC_ID}`, sk: 'state' }

const buildEvent = (body: unknown) =>
  ({ body: JSON.stringify(body) }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status })

const mockFetch = (res: Response) => {
  global.fetch = jest.fn().mockResolvedValue(res) as unknown as typeof fetch
}

const stateUpdate = () =>
  ddbMock
    .commandCalls(UpdateCommand)
    .find((c) => (c.args[0].input as { Key?: { pk?: string } }).Key?.pk === STATE_KEY.pk)?.args[0]
    .input as { ExpressionAttributeValues?: Record<string, unknown> } | undefined

beforeEach(() => {
  ddbMock.reset()
  ddbMock.on(GetCommand, { Key: STATE_KEY }).resolves({ Item: { needsInputType: 'new_vendor' } })
  ddbMock.on(UpdateCommand).resolves({})
})

describe('approveVendor', () => {
  test('creates the vendor with a Bearer token and records vendorRef', async () => {
    mockFetch(jsonResponse(201, { id: '77', displayName: 'Acme' }))

    const res = await approveVendor(buildEvent({ documentId: DOC_ID, vendorName: 'Acme' }), ddb)

    expect(res.statusCode).toBe(200)
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe('https://qbo-service.test/vendors')
    expect(init.headers.Authorization).toBe('Bearer test-token')
    expect(stateUpdate()?.ExpressionAttributeValues?.[':qboVendorRef']).toEqual({
      value: '77',
      name: 'Acme',
    })
    expect(JSON.parse(res.body).message).toContain('created')
  })

  test('QBO 409 duplicate → adopts the existing vendor', async () => {
    mockFetch(
      jsonResponse(409, {
        error: 'Vendor already exists',
        existing: { id: '12', displayName: 'Acme', active: true },
      }),
    )

    const res = await approveVendor(buildEvent({ documentId: DOC_ID, vendorName: 'Acme' }), ddb)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).vendor).toMatchObject({ id: '12', displayName: 'Acme' })
    // the message tells the truth: the vendor was adopted, not created
    expect(JSON.parse(res.body).message).toContain('already exists')
    expect(stateUpdate()?.ExpressionAttributeValues?.[':qboVendorRef']).toEqual({
      value: '12',
      name: 'Acme',
    })
  })

  test.each([
    ['no id', { id: undefined, displayName: 'Acme' }],
    ['empty existing', {}],
  ])('QBO 409 with unusable existing (%s) → 502, no state update', async (_n, existing) => {
    mockFetch(jsonResponse(409, { error: 'Vendor already exists', existing }))

    const res = await approveVendor(buildEvent({ documentId: DOC_ID, vendorName: 'Acme' }), ddb)

    expect(res.statusCode).toBe(502)
    expect(stateUpdate()).toBeUndefined()
  })

  test('QBO 409 with inactive existing vendor → 502 (reactivate), no state update', async () => {
    mockFetch(jsonResponse(409, { existing: { id: '12', displayName: 'Acme', active: false } }))

    const res = await approveVendor(buildEvent({ documentId: DOC_ID, vendorName: 'Acme' }), ddb)

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).message).toContain('Reactivate')
    expect(stateUpdate()).toBeUndefined()
  })

  test('QBO 409 where displayName differs only in case → adopted with QBO displayName', async () => {
    mockFetch(jsonResponse(409, { existing: { id: '12', displayName: 'ACME', active: true } }))

    const res = await approveVendor(buildEvent({ documentId: DOC_ID, vendorName: 'Acme' }), ddb)

    expect(res.statusCode).toBe(200)
    expect(stateUpdate()?.ExpressionAttributeValues?.[':qboVendorRef']).toEqual({
      value: '12',
      name: 'ACME',
    })
    // the displayed vendor follows the adopted QBO vendor (B5)
    expect(stateUpdate()?.ExpressionAttributeValues?.[':vendorDisplay']).toBe('ACME')
  })

  test('QBO 401 → 502 and no state update', async () => {
    mockFetch(jsonResponse(401, { message: 'Unauthorized' }))

    const res = await approveVendor(buildEvent({ documentId: DOC_ID, vendorName: 'Acme' }), ddb)

    expect(res.statusCode).toBe(502)
    expect(stateUpdate()).toBeUndefined()
  })

  test('expense not found → 404, no QBO call', async () => {
    ddbMock.on(GetCommand, { Key: STATE_KEY }).resolves({})
    mockFetch(jsonResponse(201, {}))

    const res = await approveVendor(buildEvent({ documentId: DOC_ID, vendorName: 'Acme' }), ddb)

    expect(res.statusCode).toBe(404)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('wrong needsInputType → 400, no QBO call', async () => {
    ddbMock
      .on(GetCommand, { Key: STATE_KEY })
      .resolves({ Item: { needsInputType: 'account_selection' } })
    mockFetch(jsonResponse(201, {}))

    const res = await approveVendor(buildEvent({ documentId: DOC_ID, vendorName: 'Acme' }), ddb)

    expect(res.statusCode).toBe(400)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
