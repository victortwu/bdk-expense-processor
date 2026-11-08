import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'

jest.mock('../../lambdas/api/utils/getAuthToken', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-token'),
}))

import { listQboVendors, listQboAccounts } from '../../lambdas/api/handlers/listQboLookups'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const event = (refresh?: string) =>
  ({
    queryStringParameters: refresh === undefined ? undefined : { refresh },
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer

const json = (status: number, body: unknown) =>
  Promise.resolve({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as Promise<Response>
const mockFetch = (impl: () => Promise<Response>) => {
  global.fetch = jest.fn(impl) as unknown as typeof fetch
}

const STALE = '2000-01-01T00:00:00.000Z'
const FRESH = new Date().toISOString()
const rawVendors = [
  { id: '1', displayName: 'Sysco', active: true },
  { id: '2', displayName: 'Gone Co', active: false },
]
const rawAccounts = [
  { id: '80', name: 'Food', fullyQualifiedName: 'COGS:Food', accountType: 'Cost of Goods Sold' },
]

const body = (r: { body?: string }) => JSON.parse(r.body ?? '')

beforeEach(() => {
  ddbMock.reset()
  ddbMock.on(GetCommand).resolves({})
})

describe('GET /qbo/vendors', () => {
  test('fetches, drops inactive, strips fields, caches raw list', async () => {
    mockFetch(() => json(200, { vendors: rawVendors, count: 2 }))
    const res = await listQboVendors(event(), ddb)
    expect(res.statusCode).toBe(200)
    expect(body(res)).toMatchObject({ vendors: [{ id: '1', displayName: 'Sysco' }], count: 1 })
    expect(body(res).vendors[0]).not.toHaveProperty('active')
    expect(body(res).cachedAt).toEqual(expect.any(String))
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({
      pk: 'CACHE#qbo-vendors',
      sk: 'v0',
      vendors: rawVendors,
    })
    expect((global.fetch as jest.Mock).mock.calls[0]).toEqual([
      'https://qbo-service.test/vendors',
      { headers: { Authorization: 'Bearer test-token' } },
    ])
  })

  test('fresh cache is served without fetch; refresh=true bypasses it', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { vendors: rawVendors, refreshedAt: FRESH } })
    mockFetch(() => json(200, { vendors: [rawVendors[0]] }))

    const cached = await listQboVendors(event(), ddb)
    expect(body(cached)).toMatchObject({ count: 1, cachedAt: FRESH })
    expect(global.fetch).not.toHaveBeenCalled()

    const refreshed = await listQboVendors(event('true'), ddb)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(body(refreshed).cachedAt).not.toBe(FRESH)
  })

  test('QBO 401 QBO_AUTH_EXPIRED with no cache -> 502 QBO_AUTH_EXPIRED', async () => {
    mockFetch(() => json(401, { error: { code: 'QBO_AUTH_EXPIRED', message: 'expired' } }))
    const res = await listQboVendors(event(), ddb)
    expect(res.statusCode).toBe(502)
    expect(body(res)).toMatchObject({ error: 'QBO_AUTH_EXPIRED', message: expect.any(String) })
  })

  test('upstream 500 serves stale cache and does not overwrite it', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { vendors: rawVendors, refreshedAt: STALE } })
    mockFetch(() => json(500, {}))
    const res = await listQboVendors(event(), ddb)
    expect(res.statusCode).toBe(200)
    expect(body(res)).toMatchObject({ count: 1, cachedAt: STALE })
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
  })

  test.each([
    ['{}', {}],
    ['error body', { error: 'x' }],
  ])('malformed 200 (%s) is not cached and -> 502', async (_name, payload) => {
    mockFetch(() => json(200, payload))
    expect((await listQboVendors(event(), ddb)).statusCode).toBe(502)
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
  })

  // Only exactly 'true' (case-insensitive) forces a refresh; anything else uses the cache.
  test.each([
    ['true', true],
    ['TRUE', true],
    ['', false],
    ['1', false],
    ['false', false],
  ])('refresh=%j forces refetch: %s', async (value, forced) => {
    ddbMock.on(GetCommand).resolves({ Item: { vendors: rawVendors, refreshedAt: FRESH } })
    mockFetch(() => json(200, { vendors: rawVendors }))
    await listQboVendors(event(value), ddb)
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(forced ? 1 : 0)
  })

  test('upstream 500 with no cache -> 502', async () => {
    mockFetch(() => json(500, {}))
    const res = await listQboVendors(event(), ddb)
    expect(res.statusCode).toBe(502)
    expect(body(res)).toEqual({ message: expect.any(String) })
  })
})

describe('GET /qbo/accounts', () => {
  test('fetches accounts and caches under CACHE#qbo-accounts', async () => {
    mockFetch(() => json(200, { accounts: rawAccounts, count: 1 }))
    const res = await listQboAccounts(event(), ddb)
    expect(res.statusCode).toBe(200)
    expect(body(res)).toMatchObject({ accounts: rawAccounts, count: 1 })
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('https://qbo-service.test/accounts')
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({
      pk: 'CACHE#qbo-accounts',
      sk: 'v0',
      accounts: rawAccounts,
    })
  })
})
