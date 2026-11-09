/** Route table + router: matching, path params, 404, malformed JSON → 400, ApiError envelope. */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2WithJWTAuthorizer, Context } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'

import { handler } from '../../lambdas/api/index'
import { routes } from '../../lambdas/api/routes'
import { matchRoute } from '../../lambdas/api/utils/matchRoute'
import { ApiError, ApiEvent, parseJsonBody } from '../../lambdas/shared/http/respond'

const ddbMock = mockClient(DynamoDBDocumentClient)

const invoke = (method: string, path: string, body?: string) =>
  handler(
    {
      rawPath: path,
      body,
      requestContext: { http: { method } },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer,
    {} as Context,
    () => {},
  ) as Promise<{ statusCode: number; body: string }>

beforeEach(() => ddbMock.reset())

describe('matchRoute', () => {
  it.each([
    ['GET', '/expenses', 'GET /expenses', {}],
    ['GET', '/expenses/abc', 'GET /expenses/{documentId}', { documentId: 'abc' }],
    ['POST', '/expenses/submit', 'POST /expenses/submit', {}],
    ['POST', '/expenses/set-account', 'POST /expenses/set-account', {}],
    [
      'POST',
      '/expenses/abc/correct-and-submit',
      'POST /expenses/{documentId}/correct-and-submit',
      { documentId: 'abc' },
    ],
    ['PUT', '/rules/Franz%20Bakery', 'PUT /rules/{vendorName}', { vendorName: 'Franz Bakery' }],
    ['DELETE', '/rules/x', 'DELETE /rules/{vendorName}', { vendorName: 'x' }],
    ['GET', '/qbo/vendors', 'GET /qbo/vendors', {}],
  ])('%s %s → %s', (method, path, expected, params) => {
    const match = matchRoute(routes, method, path)
    expect(`${match?.route.method} ${match?.route.path}`).toBe(expected)
    expect(match?.params).toEqual(params)
  })

  it.each([
    ['GET', '/expenses/abc/submit'], // previously swallowed by a path.includes() chain
    ['GET', '/expenses/submit/extra'],
    ['DELETE', '/expenses/abc'],
    ['GET', '/rules/a/b'],
    ['GET', '/nope'],
    ['GET', '/expenses/'],
  ])('%s %s → no match', (method, path) => {
    expect(matchRoute(routes, method, path)).toBeNull()
  })

  it('every route is unique', () => {
    const ids = routes.map((r) => `${r.method} ${r.path}`)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('router', () => {
  it('unknown route → 404 with the route in the message', async () => {
    const res = await invoke('GET', '/nope')
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).message).toBe('Route not found: GET /nope')
  })

  it('injects path parameters into the handler', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { documentId: 'abc', status: 'ready' } })
    const res = await invoke('GET', '/expenses/abc')
    expect(res.statusCode).toBe(200)
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input.Key).toEqual({
      pk: 'DOC#abc',
      sk: 'state',
    })
  })

  it.each([
    'POST /expenses/skip',
    'POST /expenses/submit',
    'POST /expenses/retry',
    'POST /expenses/set-account',
    'POST /expenses/approve-vendor',
    'PUT /rules/x',
  ])('%s with malformed JSON → 400 (not 500)', async (route) => {
    const [method, path] = route.split(' ')
    const res = await invoke(method, path, '{not json')
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Request body must be valid JSON')
  })

  it('malformed JSON on correct-and-submit → 400', async () => {
    const res = await invoke('POST', '/expenses/abc/correct-and-submit', '[1')
    expect(res.statusCode).toBe(400)
  })

  it('unexpected errors → generic 500 without leaking details', async () => {
    ddbMock.on(GetCommand).rejects(new Error('secret internals'))
    const res = await invoke('POST', '/expenses/abc/correct-and-submit', '{}')
    expect(res.statusCode).toBe(500)
    expect(res.body).not.toContain('secret internals')
  })
})

describe('parseJsonBody / ApiError', () => {
  const event = (body?: string) => ({ body }) as unknown as ApiEvent

  it('parses objects, treats empty as {}', () => {
    expect(parseJsonBody(event('{"a":1}'))).toEqual({ a: 1 })
    expect(parseJsonBody(event(undefined))).toEqual({})
  })

  it.each(['null', '[]', '"s"', '5', '{bad'])('rejects %s with a 400 ApiError', (raw) => {
    expect(() => parseJsonBody(event(raw))).toThrow(ApiError)
  })

  it('ApiError renders the { message, ...extra } envelope', () => {
    const res = new ApiError(409, 'nope', { error: 'X' }).toResponse()
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ message: 'nope', error: 'X' })
  })
})
