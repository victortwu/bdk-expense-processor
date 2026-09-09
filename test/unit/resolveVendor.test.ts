/**
 * resolveVendor / vendor-cache tests — regression coverage for the cache-poisoning
 * bug found in UAT Run 1 (2026-09-09).
 * ────────────────────────────────────────────────────────────────────────────
 * BUG: a transient QBO `GET /vendors` 503 caused fetchVendorsFromQbo() to return
 * [], and getCachedVendors() wrote that empty list into CACHE#qbo-vendors with a
 * fresh refreshedAt. Every subsequent document in the batch then read the
 * "fresh-but-empty" cache and short-circuited to needs_input:new_vendor — one
 * blip cascading into many false negatives.
 *
 * FIX: fetchVendorsFromQbo() now returns a discriminated result ({ok:true,vendors}
 * | {ok:false}). getCachedVendors() ONLY writes the cache on a successful fetch;
 * on failure it preserves the existing (even stale) cache and lets the next lookup
 * retry.
 *
 * These tests mock DynamoDB (aws-sdk-client-mock), getAuthToken (jest.mock), and
 * global.fetch. Env must be set before importing the module under test.
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'

process.env.TABLE_NAME = 'test-expense-table'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'
process.env.COGNITO_TOKEN_URL = 'https://cognito.test/oauth2/token'
process.env.MACHINE_CLIENT_ID = 'test-client-id'
process.env.MACHINE_CLIENT_SECRET = 'test-client-secret'

// Bypass the real Cognito client-credentials fetch.
jest.mock('../../lambdas/event-handler/utils/getAuthToken', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-token'),
}))

import { resolveVendor } from '../../lambdas/event-handler/vendors/resolveVendor'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const TWO_DAYS_AGO = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

const cachePut = () =>
  ddbMock
    .commandCalls(PutCommand)
    .filter(
      (c) => (c.args[0].input as { Item?: { pk?: string } }).Item?.pk === 'CACHE#qbo-vendors',
    )

const mockFetch = (impl: () => Promise<Response>) => {
  global.fetch = jest.fn(impl) as unknown as typeof fetch
}

beforeEach(() => {
  ddbMock.reset()
  jest.clearAllMocks()
})

describe('resolveVendor vendor cache', () => {
  test('fresh non-empty cache is used without any fetch or write', async () => {
    // arrange
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'CACHE#qbo-vendors',
        sk: 'v0',
        refreshedAt: ONE_HOUR_AGO,
        vendors: [{ id: '60', displayName: 'Seattle City Light' }],
      },
    })
    mockFetch(() => {
      throw new Error('fetch should not be called on a fresh cache')
    })

    // act
    const result = await resolveVendor(ddb, 'Seattle City Light')

    // assert
    expect(result).toEqual({ id: '60', displayName: 'Seattle City Light' })
    expect(cachePut()).toHaveLength(0)
  })

  test('FAILED fetch (503) does NOT write the cache — regression for Run 1 poisoning', async () => {
    // arrange: no existing cache, forcing a refresh; QBO returns 503
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    ddbMock.on(PutCommand).resolves({})
    mockFetch(async () => new Response('unavailable', { status: 503 }))

    // act
    const result = await resolveVendor(ddb, 'Franz Bakery')

    // assert: no match AND critically no cache write (would have poisoned the batch)
    expect(result).toBeNull()
    expect(cachePut()).toHaveLength(0)
  })

  test('FAILED fetch falls back to existing STALE cache instead of empty', async () => {
    // arrange: stale-but-present cache; fetch fails → preserve stale vendors
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'CACHE#qbo-vendors',
        sk: 'v0',
        refreshedAt: TWO_DAYS_AGO,
        vendors: [{ id: '62', displayName: 'West Coast Pita & Foods, Inc' }],
      },
    })
    mockFetch(async () => new Response('unavailable', { status: 503 }))

    // act
    const result = await resolveVendor(ddb, 'West Coast Pita')

    // assert: matched from preserved stale cache; no poisoning write
    expect(result).toEqual({ id: '62', displayName: 'West Coast Pita & Foods, Inc' })
    expect(cachePut()).toHaveLength(0)
  })

  test('SUCCESSFUL fetch writes the cache and resolves the vendor', async () => {
    // arrange: cache miss → successful /vendors returning a real list
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    ddbMock.on(PutCommand).resolves({})
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({ vendors: [{ id: '60', displayName: 'Seattle City Light' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )

    // act
    const result = await resolveVendor(ddb, 'Seattle City Light')

    // assert: matched AND cache written with the fetched list
    expect(result).toEqual({ id: '60', displayName: 'Seattle City Light' })
    const puts = cachePut()
    expect(puts).toHaveLength(1)
    const item = puts[0].args[0].input.Item as { vendors: unknown[] }
    expect(item.vendors).toHaveLength(1)
  })

  test('SUCCESSFUL but genuinely-empty fetch IS cacheable (legit zero-vendor account)', async () => {
    // arrange: cache miss → successful /vendors returning an empty list
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    ddbMock.on(PutCommand).resolves({})
    mockFetch(
      async () =>
        new Response(JSON.stringify({ vendors: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )

    // act
    const result = await resolveVendor(ddb, 'Anyone')

    // assert: no match, but an empty list from a SUCCESSFUL fetch is a valid cache state
    expect(result).toBeNull()
    expect(cachePut()).toHaveLength(1)
  })

  test('transient 503 then 200 → retries and succeeds (absorbs Run 1 cold-start blip)', async () => {
    // arrange: first call 503, second call 200 with a real vendor
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    ddbMock.on(PutCommand).resolves({})
    let call = 0
    mockFetch(async () => {
      call++
      if (call === 1) return new Response('unavailable', { status: 503 })
      return new Response(
        JSON.stringify({ vendors: [{ id: '60', displayName: 'Seattle City Light' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    // act
    const result = await resolveVendor(ddb, 'Seattle City Light')

    // assert: retry succeeded, vendor resolved, cache written
    expect(call).toBe(2)
    expect(result).toEqual({ id: '60', displayName: 'Seattle City Light' })
    expect(cachePut()).toHaveLength(1)
  })

  test('4xx is NOT retried (client/auth error) and does not write the cache', async () => {
    // arrange: 401 unauthorized on every call
    ddbMock.on(GetCommand).resolves({ Item: undefined })
    ddbMock.on(PutCommand).resolves({})
    let call = 0
    mockFetch(async () => {
      call++
      return new Response('unauthorized', { status: 401 })
    })

    // act
    const result = await resolveVendor(ddb, 'Franz Bakery')

    // assert: exactly one attempt (no retry), null result, no cache write
    expect(call).toBe(1)
    expect(result).toBeNull()
    expect(cachePut()).toHaveLength(0)
  })
})
