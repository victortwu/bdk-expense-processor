/** POST /expenses/from-document/{documentId} — idempotent open-or-create, tenant-scoped, no QBO. */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'
process.env.PARSELY_API_URL = 'https://parsely.test'

const JWT = 'Bearer caller.jwt.token'

import { createExpenseFromDocument } from '../../lambdas/api/handlers/createExpenseFromDocument'
import { handler } from '../../lambdas/api/index'
import { ApiError } from '../../lambdas/shared/http/respond'
import { installFakeTable } from '../helpers/fakeTable'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const DOC = '01DOCUMENT0000000000000000'
const TENANT = 'tenant-1'

const parselyDoc = {
  tenantId: TENANT,
  documentId: DOC,
  documentType: 'tax',
  vendorName: 'franz-bakery',
  vendorDisplay: 'Franz Bakery',
  documentDate: '2026-01-02',
  amounts: ['$1,234.00', '$10.00'],
  description: 'Bread order',
  originalUri: 's3://processed/t/DOC/original.pdf',
}

const event = (
  claims: Record<string, string> = { 'custom:tenantId': TENANT },
  id: string | undefined = DOC,
) =>
  ({
    body: undefined,
    headers: { authorization: JWT },
    pathParameters: id ? { documentId: id } : {},
    requestContext: { authorizer: { jwt: { claims } } },
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer

/** The handler throws ApiError; the router (index.ts) turns it into the response. */
const call = async (ev: APIGatewayProxyEventV2WithJWTAuthorizer) => {
  try {
    return await createExpenseFromDocument(ev, ddb)
  } catch (err) {
    if (err instanceof ApiError) return err.toResponse()
    throw err
  }
}

let table: ReturnType<typeof installFakeTable>
let fetchMock: jest.Mock

const parselyResponds = (status: number, body: unknown = {}) =>
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }))

beforeEach(() => {
  ddbMock.reset()
  table = installFakeTable(ddbMock)
  fetchMock = jest.fn()
  global.fetch = fetchMock as unknown as typeof fetch
  parselyResponds(200, parselyDoc)
})

describe('createExpenseFromDocument', () => {
  it('creates a human-owned needs_input/review item seeded from the document (201)', async () => {
    const res = await call(event())

    expect(res.statusCode).toBe(201)
    const { created, expense } = JSON.parse(res.body)
    expect(created).toBe(true)
    expect(expense).toMatchObject({
      pk: `DOC#${DOC}`,
      sk: 'state',
      tenantId: TENANT,
      documentId: DOC,
      status: 'needs_input',
      needsInputType: 'review',
      bookingOwner: 'human',
      vendorName: 'franz-bakery',
      vendorDisplay: 'Franz Bakery',
      documentDate: '2026-01-02',
      amounts: ['$1,234.00', '$10.00'],
      description: 'Bread order',
      originalUri: 's3://processed/t/DOC/original.pdf',
      attempts: 0,
    })
    expect(table.get(`DOC#${DOC}`, 'state')).toMatchObject({ status: 'needs_input' })
  })

  it("forwards the caller's own JWT to Parsely; every fetch targets Parsely, never QBO or Cognito", async () => {
    await call(event())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      `https://parsely.test/documents/${DOC}`,
      expect.objectContaining({ headers: { Authorization: JWT } }),
    )
    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(String(url)).host).toBe('parsely.test')
    }
  })

  it('a hung Parsely (timeout/abort) is a 502, nothing written', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))

    const res = await call(event())

    expect(res.statusCode).toBe(502)
    expect(table.get(`DOC#${DOC}`, 'state')).toBeUndefined()
  })

  it.each([401, 403])('Parsely %s (upstream auth failure) is a 502, not a created item', async (s) => {
    parselyResponds(s)

    const res = await call(event())

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'PARSELY_UNAVAILABLE' })
    expect(table.get(`DOC#${DOC}`, 'state')).toBeUndefined()
  })

  it('fails fast with a clear error when PARSELY_API_URL is not configured', async () => {
    const saved = process.env.PARSELY_API_URL
    delete process.env.PARSELY_API_URL
    try {
      const res = await call(event())
      expect(res.statusCode).toBe(502)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      process.env.PARSELY_API_URL = saved
    }
  })

  it('seeds empty fields when the document lacks vendor/date/amounts', async () => {
    parselyResponds(200, { tenantId: TENANT, documentId: DOC })

    const { expense } = JSON.parse((await call(event())).body)

    expect(expense).toMatchObject({ vendorName: 'unknown', documentDate: '', amounts: [] })
  })

  it.each(['submitted', 'skipped', 'ready'])(
    'is idempotent: an existing %s item is returned untouched (200, no Parsely call)',
    async (status) => {
      const existing = {
        pk: `DOC#${DOC}`,
        sk: 'state',
        tenantId: TENANT,
        documentId: DOC,
        status,
        attempts: 3,
      }
      table.put(existing)

      const res = await call(event())

      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ created: false, expense: existing })
      expect(table.get(`DOC#${DOC}`, 'state')).toEqual(existing)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('a lost create race returns the winner (200 created:false), never overwriting it', async () => {
    const winner = {
      pk: `DOC#${DOC}`,
      sk: 'state',
      tenantId: TENANT,
      documentId: DOC,
      status: 'ready',
    }
    // The item appears while the Parsely fetch is in flight.
    fetchMock.mockImplementation(async () => {
      table.put(winner)
      return new Response(JSON.stringify(parselyDoc), { status: 200 })
    })

    const res = await call(event())

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ created: false, expense: winner })
  })

  it('404 DOCUMENT_NOT_FOUND when Parsely has no such document for the tenant', async () => {
    parselyResponds(404)

    const res = await call(event())

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'DOCUMENT_NOT_FOUND' })
  })

  it("404 for another tenant's document or existing item (no existence leak)", async () => {
    const other = event({ 'custom:tenantId': 'tenant-2' })

    expect((await call(other)).statusCode).toBe(404)
    expect(table.get(`DOC#${DOC}`, 'state')).toBeUndefined()

    table.put({ pk: `DOC#${DOC}`, sk: 'state', tenantId: TENANT, documentId: DOC, status: 'ready' })
    expect((await call(other)).statusCode).toBe(404)
  })

  it('403 for any tenant-less token (never "any tenant"), Parsely never called', async () => {
    const res = await call(event({ client_id: 'some-client' }))

    expect(res.statusCode).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['..', 'a/b', 'a%2Fb', 'x'.repeat(129)])(
    '400 for a malformed documentId %p, Parsely never called',
    async (id) => {
      expect((await call(event(undefined, id))).statusCode).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['5xx', () => parselyResponds(503)],
    [
      'a document that is not the one asked for',
      () => parselyResponds(200, { ...parselyDoc, documentId: 'OTHER' }),
    ],
    ['a document without a tenant', () => parselyResponds(200, { documentId: DOC })],
    ['network error', () => fetchMock.mockRejectedValue(new Error('ECONNRESET'))],
  ])('502 PARSELY_UNAVAILABLE on upstream %s, nothing written', async (_n, arrange) => {
    arrange()

    const res = await call(event())

    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'PARSELY_UNAVAILABLE' })
    expect(table.get(`DOC#${DOC}`, 'state')).toBeUndefined()
  })

  it('400 without a documentId', async () => {
    expect((await call(event(undefined, ''))).statusCode).toBe(400)
  })
})

describe('routing', () => {
  it('POST /expenses/from-document/{id} reaches the handler (not GET /expenses/{id})', async () => {
    const res = (await handler(
      {
        rawPath: `/expenses/from-document/${DOC}`,
        headers: { authorization: JWT },
        requestContext: {
          http: { method: 'POST' },
          authorizer: { jwt: { claims: { 'custom:tenantId': TENANT } } },
        },
      } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer,
      {} as never,
      () => {},
    )) as { statusCode: number }

    expect(res.statusCode).toBe(201)
  })
})
