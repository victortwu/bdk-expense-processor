/** Bulk submit / retry / skip — through the shared booking path, with real conditional state writes. */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'

jest.mock('../../lambdas/shared/auth/getAuthToken', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-token'),
}))

import { retryExpenses } from '../../lambdas/api/handlers/retryExpenses'
import { skipExpenses } from '../../lambdas/api/handlers/skipExpenses'
import { submitExpenses } from '../../lambdas/api/handlers/submitExpenses'
import { installFakeTable } from '../helpers/fakeTable'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const payload = {
  docNumber: 'd',
  txnDate: '2026-01-02',
  paymentType: 'CreditCard',
  paymentAccountRef: { value: '41', name: 'Visa' },
  entityRef: { value: '55', name: 'Franz Bakery' },
  lines: [{ amount: 475.65, accountRef: { value: '80', name: 'COGS' }, description: 'x' }],
  privateNote: 'n',
}

const expense = (id: string, over: Record<string, unknown> = {}) => ({
  pk: `DOC#${id}`,
  sk: 'state',
  documentId: id,
  status: 'ready',
  vendorName: 'franz-bakery',
  documentDate: '2026-01-02',
  amounts: ['$475.65'],
  qboVendorRef: { value: '55', name: 'Franz Bakery' },
  qboPayload: payload,
  attempts: 0,
  ...over,
})

const event = (body: unknown) =>
  ({ body: JSON.stringify(body) }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer

let table: ReturnType<typeof installFakeTable>
let posts: { url: string; body: any }[]

beforeEach(() => {
  ddbMock.reset()
  posts = []
  global.fetch = jest.fn(async (url: string, init: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ id: `P-${posts.length}`, docNumber: 'D' }), {
      status: 200,
    })
  }) as unknown as typeof fetch
})

describe('submitExpenses (B2: bulk Submit actually books)', () => {
  it('books ready rows from the persisted qboPayload and writes the pipeline-compatible marker', async () => {
    table = installFakeTable(ddbMock, [
      expense('a', { invoiceNumber: 'INV-7', chargeKey: 'CHARGE#55#INV#INV-7' }),
    ])

    const res = await submitExpenses(event({ documentIds: ['a'] }), ddb)

    expect(JSON.parse(res.body)).toEqual({
      submitted: 1,
      failed: 0,
      results: [{ documentId: 'a', success: true }],
    })
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual(payload)
    expect(table.get('DOC#a', 'state')).toMatchObject({ status: 'submitted', qboPurchaseId: 'P-1' })
    expect(table.get('CHARGE#55#INV#INV-7', 'marker')).toMatchObject({
      qboPurchaseId: 'P-1',
      invoiceNumber: 'INV-7',
    })
  })

  it('B1: without a stored chargeKey it derives the invoice key from the stored invoiceNumber', async () => {
    table = installFakeTable(ddbMock, [expense('a', { invoiceNumber: 'INV-8' })])

    await submitExpenses(event({ documentIds: ['a'] }), ddb)

    expect(table.get('CHARGE#55#INV#INV-8', 'marker')).toBeDefined()
  })

  it('B3: the fallback key uses amounts[0], like the pipeline, not lines[0]', async () => {
    const multi = {
      ...payload,
      lines: [
        { ...payload.lines[0], amount: 400 },
        { ...payload.lines[0], amount: 75.65 },
      ],
    }
    table = installFakeTable(ddbMock, [expense('a', { qboPayload: multi })])

    await submitExpenses(event({ documentIds: ['a'] }), ddb)

    expect(table.get('CHARGE#55#AMT#475.65#2026-01-02', 'marker')).toBeDefined()
  })

  it('reports per-document reasons without aborting the batch', async () => {
    table = installFakeTable(ddbMock, [
      expense('ok'),
      expense('wrong', { status: 'failed' }),
      expense('nopayload', { qboPayload: undefined }),
      expense('booked', { qboVendorRef: { value: '55', name: 'F' }, amounts: ['$9.00'] }),
      {
        pk: 'CHARGE#55#AMT#9.00#2026-01-02',
        sk: 'marker',
        documentId: 'other',
        qboPurchaseId: 'P-X',
      },
    ])

    const res = await submitExpenses(
      event({ documentIds: ['ok', 'missing', 'wrong', 'nopayload', 'booked'] }),
      ddb,
    )

    const body = JSON.parse(res.body)
    expect(body.submitted).toBe(1)
    expect(body.failed).toBe(4)
    expect(body.results.map((r: { error?: string }) => r.error)).toEqual([
      undefined,
      'Expense not found',
      'Cannot submit expense with status: failed',
      'No QBO payload available',
      'Looks already booked as purchase P-X',
    ])
    expect(posts).toHaveLength(1)
  })

  it('400 when documentIds is missing/empty', async () => {
    table = installFakeTable(ddbMock)
    await expect(submitExpenses(event({}), ddb)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('retryExpenses', () => {
  it('re-books a failed row, clears the failure fields and counts the attempt', async () => {
    table = installFakeTable(ddbMock, [
      expense('f', { status: 'failed', failureReason: 'QBO boom', failedAt: 't', attempts: 1 }),
    ])

    const res = await retryExpenses(event({ documentIds: ['f'] }), ddb)

    expect(JSON.parse(res.body).submitted).toBe(1)
    const state = table.get('DOC#f', 'state')!
    expect(state).toMatchObject({ status: 'submitted', attempts: 2 })
    expect(state).not.toHaveProperty('failureReason')
    expect(state).not.toHaveProperty('failedAt')
  })

  it('only retries failed rows', async () => {
    table = installFakeTable(ddbMock, [expense('r')])
    const res = await retryExpenses(event({ documentIds: ['r'] }), ddb)
    expect(JSON.parse(res.body).results[0].error).toBe('Cannot retry expense with status: ready')
  })

  it('a QBO failure marks the row failed (and stays retryable)', async () => {
    table = installFakeTable(ddbMock, [expense('f', { status: 'failed' })])
    global.fetch = jest.fn(
      async () => new Response('down', { status: 503 }),
    ) as unknown as typeof fetch

    const res = await retryExpenses(event({ documentIds: ['f'] }), ddb)

    expect(JSON.parse(res.body)).toMatchObject({ submitted: 0, failed: 1 })
    expect(table.get('DOC#f', 'state')).toMatchObject({ status: 'failed', attempts: 1 })
  })
})

describe('skipExpenses (B4: status guard)', () => {
  it('skips unbooked rows but refuses submitted and missing ones', async () => {
    table = installFakeTable(ddbMock, [expense('r'), expense('s', { status: 'submitted' })])

    const res = await skipExpenses(event({ documentIds: ['r', 's', 'nope'] }), ddb)

    expect(JSON.parse(res.body)).toEqual({
      skipped: 1,
      failed: 2,
      results: [
        { documentId: 'r', success: true },
        { documentId: 's', success: false, error: 'Cannot skip expense with status: submitted' },
        { documentId: 'nope', success: false, error: 'Expense not found' },
      ],
    })
    expect(table.get('DOC#r', 'state')!.status).toBe('skipped')
    expect(table.get('DOC#s', 'state')!.status).toBe('submitted')
  })
})
