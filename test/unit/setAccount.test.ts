/**
 * setAccount handler tests — regression for the 502 "Unauthorized" found in UAT
 * Run 2 (2026-09-09).
 * ────────────────────────────────────────────────────────────────────────────
 * BUGS FIXED:
 *  1. POST /purchases was sent with NO Authorization header → QBO Service (JWT
 *     protected) returned 401 → handler returned 502.
 *  2. paymentAccountRef was hardcoded to a placeholder ({value:'1'}) instead of
 *     CONFIG#defaults.paymentAccountRef.
 *  3. amount was taken raw from expense.amounts[0] (a "$1,234.56" string) without
 *     parsing → non-numeric amount to QBO.
 *
 * Mocks DynamoDB (aws-sdk-client-mock), getAuthToken (jest.mock), global.fetch.
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'
process.env.COGNITO_TOKEN_URL = 'https://cognito.test/oauth2/token'
process.env.MACHINE_CLIENT_ID = 'test-client-id'
process.env.MACHINE_CLIENT_SECRET = 'test-client-secret'

jest.mock('../../lambdas/api/utils/getAuthToken', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-token'),
}))

import { setAccount } from '../../lambdas/api/handlers/setAccount'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const DOC_ID = '01TESTDOC0000000000000000'

const expenseState = {
  pk: `DOC#${DOC_ID}`,
  sk: 'state',
  documentId: DOC_ID,
  status: 'needs_input',
  needsInputType: 'pick_expense_account',
  vendorName: 'Burton Auto',
  vendorDisplay: 'Burton Auto',
  documentDate: '2025-06-12',
  amounts: ['$586.37'],
  qboVendorRef: { value: '63', name: 'Burton Auto' },
  description: 'Auto repair',
}

const configDefaults = {
  pk: 'CONFIG#defaults',
  sk: 'v0',
  paymentAccountRef: { value: '41', name: 'Visa' },
}

const buildEvent = (body: unknown): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({ body: JSON.stringify(body) }) as APIGatewayProxyEventV2WithJWTAuthorizer

const mockFetch = (impl: () => Promise<Response>) => {
  global.fetch = jest.fn(impl) as unknown as typeof fetch
}

beforeEach(() => {
  ddbMock.reset()
  jest.clearAllMocks()
})

describe('setAccount', () => {
  test('sends Bearer auth, config paymentAccountRef, and parsed amount to QBO', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(UpdateCommand).resolves({})

    let capturedInit: RequestInit | undefined
    mockFetch(async () => {
      // capture is done via the jest.fn wrapper below
      return new Response(JSON.stringify({ id: '200', docNumber: 'DOC-200' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const fetchSpy = global.fetch as jest.Mock

    // act
    const res = await setAccount(
      buildEvent({ documentId: DOC_ID, accountRef: { value: '1150040012', name: 'Auto Repair' } }),
      ddb,
    )

    // assert
    expect(res.statusCode).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    capturedInit = init as RequestInit
    expect(url).toBe('https://qbo-service.test/purchases')
    // (1) Authorization header present
    expect((capturedInit.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
    const payload = JSON.parse(capturedInit.body as string)
    // (2) payment account from CONFIG#defaults, not the old hardcoded '1'
    expect(payload.paymentAccountRef).toEqual({ value: '41', name: 'Visa' })
    // (3) amount parsed from "$586.37" → 586.37
    expect(payload.lines[0].amount).toBe(586.37)
    expect(payload.lines[0].accountRef).toEqual({ value: '1150040012', name: 'Auto Repair' })
    expect(payload.entityRef).toEqual({ value: '63', name: 'Burton Auto' })
  })

  test('returns 500 when no default payment account is configured', async () => {
    // arrange: CONFIG#defaults has no paymentAccountRef
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: { pk: 'CONFIG#defaults', sk: 'v0' } })
    mockFetch(async () => new Response('{}', { status: 200 }))

    // act
    const res = await setAccount(
      buildEvent({ documentId: DOC_ID, accountRef: { value: '1', name: 'X' } }),
      ddb,
    )

    // assert: fail fast, no QBO call
    expect(res.statusCode).toBe(500)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('rejects when expense is not awaiting account selection', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: { ...expenseState, needsInputType: 'new_vendor' } })
    mockFetch(async () => new Response('{}', { status: 200 }))

    // act
    const res = await setAccount(
      buildEvent({ documentId: DOC_ID, accountRef: { value: '1', name: 'X' } }),
      ddb,
    )

    // assert
    expect(res.statusCode).toBe(400)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
