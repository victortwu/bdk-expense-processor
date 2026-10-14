/**
 * REGRESSION TEST — cross-path dedup closes the double-book hole (BDK #2)
 * ────────────────────────────────────────────────────────────────────────────
 * Proves the end-to-end property the shared submitCharge module exists to
 * guarantee:
 *
 *   1. A MANUAL submit via the API handler `setAccount` books to QBO AND writes
 *      the CHARGE# dedup marker (previously it did NOT write the marker).
 *   2. A later AUTOMATED event-handler reprocess of the SAME invoice reads that
 *      marker, Stage 3 returns `skip_duplicate`, and NO second QBO POST happens.
 *
 * A single Map-backed DynamoDB mock is shared across both handlers so the marker
 * written by setAccount is visible to the event-handler's dedup read. QBO is
 * mocked at global.fetch; the Stage-2 classifier is mocked to return the same
 * invoice number the manual submit used (the realistic same-invoice collision).
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import type { APIGatewayProxyEventV2WithJWTAuthorizer, SQSEvent, Context } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'
process.env.PROCESSED_BUCKET = 'test-processed-bucket'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'
process.env.COGNITO_TOKEN_URL = 'https://cognito.test/oauth2/token'
process.env.MACHINE_CLIENT_ID = 'test-client-id'
process.env.MACHINE_CLIENT_SECRET = 'test-client-secret'

// Manual-path auth: mock the API Lambda's getAuthToken.
jest.mock('../../lambdas/api/utils/getAuthToken', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-token'),
}))
// Automated-path Stage-2 classifier: controlled per test. Stage 3 stays real.
jest.mock('../../lambdas/event-handler/intent/classifyIntent', () => ({
  classifyIntent: jest.fn(),
}))

import { setAccount } from '../../lambdas/api/handlers/setAccount'
import { handler } from '../../lambdas/event-handler/index'
import { classifyIntent } from '../../lambdas/event-handler/intent/classifyIntent'
import type { IntentResult } from '../../lambdas/event-handler/intent/types'
import { CANONICAL_DOCUMENT_PROCESSED_DETAIL } from '../fixtures/documentProcessedEvent.contract'

const classifyIntentMock = classifyIntent as jest.MockedFunction<typeof classifyIntent>

const ddbMock = mockClient(DynamoDBDocumentClient)
const s3Mock = mockClient(S3Client)
const ebMock = mockClient(EventBridgeClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

// Shared invoice + vendor so the manual and automated paths compute the SAME key.
const INVOICE = '3864339'
const VENDOR_ID = '55'
const DOC_ID = CANONICAL_DOCUMENT_PROCESSED_DETAIL.documentId as string

const VENDOR_RULE = {
  pk: 'RULE#franz-bakery',
  sk: 'v0',
  ruleType: 'amount_range',
  config: { min: 1, max: 100000 },
  qboVendorRef: { value: VENDOR_ID, name: 'Franz Bakery' },
  defaultExpenseAccountRef: { value: '80', name: 'Cost of Goods Sold' },
  autoSubmit: true,
}

// In-memory table shared across both handlers. Keyed by `${pk}|${sk}`.
const store = new Map<string, Record<string, unknown>>()
const keyOf = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`

const expenseState = {
  pk: `DOC#${DOC_ID}`,
  sk: 'state',
  documentId: DOC_ID,
  status: 'needs_input',
  needsInputType: 'pick_expense_account',
  vendorName: 'franz-bakery',
  vendorDisplay: 'Franz Bakery',
  documentDate: '2026-01-02',
  amounts: ['$475.65'],
  qboVendorRef: { value: VENDOR_ID, name: 'Franz Bakery' },
  // Invoice number present on the state → setAccount uses the PRIMARY charge key,
  // matching the automated path's primary key for the same invoice.
  invoiceNumber: INVOICE,
  description: 'Bakery delivery',
}

const configDefaults = {
  pk: 'CONFIG#defaults',
  sk: 'v0',
  paymentAccountRef: { value: '41', name: 'Visa' },
}

const buildApiEvent = (body: unknown): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({ body: JSON.stringify(body) }) as APIGatewayProxyEventV2WithJWTAuthorizer

const buildSqsEvent = (detail: Record<string, unknown>): SQSEvent =>
  ({
    Records: [
      {
        messageId: 'msg-1',
        receiptHandle: 'rh-1',
        body: JSON.stringify({ source: 'parsely.processing', 'detail-type': 'DocumentProcessed', detail }),
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '0',
          SenderId: 'test',
          ApproximateFirstReceiveTimestamp: '0',
        },
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-west-2:000000000000:test',
        awsRegion: 'us-west-2',
      },
    ],
  }) as SQSEvent

const purchasePostCount = (): number =>
  (global.fetch as jest.Mock).mock.calls.filter(
    ([url, init]) => String(url).includes('/purchases') && init?.method === 'POST',
  ).length

const OAUTH_TOKEN_RESPONSE = { access_token: 'test-token', expires_in: 3600, token_type: 'Bearer' }

const installFetchMock = () => {
  global.fetch = jest.fn(async (input: unknown): Promise<Response> => {
    const url = String(input)
    if (url.includes('/oauth2/token')) {
      return { ok: true, status: 200, json: async () => OAUTH_TOKEN_RESPONSE, text: async () => '' } as unknown as Response
    }
    if (url.includes('/purchases')) {
      const body = { id: 'P-MANUAL', docNumber: 'DOC-MANUAL' }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
        headers: { get: () => null },
      } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', headers: { get: () => null } } as unknown as Response
  }) as unknown as typeof fetch
}

const makeIntent = (over: Partial<IntentResult>): IntentResult => ({
  financialIntent: 'bill',
  referencedInvoiceNumbers: [],
  intentConfidence: 'high',
  intentRationale: 'test',
  ...over,
})

beforeEach(() => {
  store.clear()
  ddbMock.reset()
  s3Mock.reset()
  ebMock.reset()
  ebMock.on(PutEventsCommand).resolves({})
  classifyIntentMock.mockReset()
  installFetchMock()

  // Seed the shared store.
  store.set(keyOf(expenseState.pk, expenseState.sk), { ...expenseState })
  store.set(keyOf(configDefaults.pk, configDefaults.sk), { ...configDefaults })
  store.set(keyOf('RULE#franz-bakery', 'v0'), { ...VENDOR_RULE })

  // Map-backed Get/Put/Update over the shared store.
  ddbMock.on(GetCommand).callsFake((input: { Key?: { pk?: unknown; sk?: unknown } }) => {
    const item = store.get(keyOf(input.Key?.pk, input.Key?.sk))
    return Promise.resolve(item ? { Item: item } : {})
  })
  ddbMock.on(PutCommand).callsFake((input: { Item?: Record<string, unknown>; ConditionExpression?: string }) => {
    const item = input.Item!
    const k = keyOf(item.pk, item.sk)
    const cond = input.ConditionExpression ?? ''
    // Marker write: strict attribute_not_exists(pk) — reject if the key exists.
    if (cond === 'attribute_not_exists(pk)' && store.has(k)) {
      const err = new Error('exists') as Error & { name: string }
      err.name = 'ConditionalCheckFailedException'
      return Promise.reject(err)
    }
    // State write: 'attribute_not_exists(pk) OR #status <> :skipped' — reject only
    // when an existing item is user-skipped.
    if (cond.includes('<> :skipped')) {
      const existing = store.get(k)
      if (existing && existing.status === 'skipped') {
        const err = new Error('skipped') as Error & { name: string }
        err.name = 'ConditionalCheckFailedException'
        return Promise.reject(err)
      }
    }
    store.set(k, item)
    return Promise.resolve({})
  })
  ddbMock.on(UpdateCommand).callsFake((input: { Key?: { pk?: unknown; sk?: unknown } }) => {
    // Mark the manual-submit expense as submitted so a reprocess reads the new status.
    const k = keyOf(input.Key?.pk, input.Key?.sk)
    const existing = store.get(k) ?? {}
    store.set(k, { ...existing, status: 'submitted' })
    return Promise.resolve({})
  })

  // Extracted text present so the event-handler runs Stage 2.
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToString: async () => `Invoice #${INVOICE} Status: Open Balance $475.65` },
  } as never)
})

describe('cross-path dedup regression (manual submit → automated reprocess)', () => {
  it('setAccount writes a marker; a later event-handler reprocess skips as duplicate with NO second POST', async () => {
    // ─── Step 1: MANUAL submit via setAccount ──────────────────────────────
    const apiRes = await setAccount(
      buildApiEvent({ documentId: DOC_ID, accountRef: { value: '80', name: 'COGS' } }),
      ddb,
    )
    expect(apiRes.statusCode).toBe(200)
    expect(purchasePostCount()).toBe(1) // one QBO POST for the manual submit

    // Marker now exists against the PRIMARY charge key for this invoice.
    const markerKey = `CHARGE#${VENDOR_ID}#INV#${INVOICE}`
    expect(store.get(keyOf(markerKey, 'marker'))).toBeDefined()
    expect(store.get(keyOf(markerKey, 'marker'))?.qboPurchaseId).toBe('P-MANUAL')

    // ─── Step 2: AUTOMATED reprocess of the SAME invoice ───────────────────
    // The idempotency check must NOT short-circuit, so simulate a reprocess by
    // resetting the DOC# state to a reprocessable status (failed). The marker
    // persists — that is what must trigger skip_duplicate.
    const docKey = keyOf(`DOC#${DOC_ID}`, 'state')
    store.set(docKey, { ...store.get(docKey), status: 'failed' })

    classifyIntentMock.mockResolvedValue(
      makeIntent({ financialIntent: 'bill', invoiceNumber: INVOICE, intentConfidence: 'high' }),
    )

    await handler(buildSqsEvent(CANONICAL_DOCUMENT_PROCESSED_DETAIL), {} as Context, () => {})

    // ─── Assert: NO second QBO POST; state recorded as skipped (duplicate) ──
    expect(purchasePostCount()).toBe(1) // still only the manual POST — no re-book
    const finalState = store.get(docKey)
    expect(finalState?.status).toBe('skipped')
    expect(String(finalState?.failureReason)).toContain('P-MANUAL')
  })
})
