/**
 * TIER-1 HANDLER TEST — INTENT GATE wiring (Stage 2 + Stage 3)
 * ────────────────────────────────────────────────────────────────────────────
 * Drives the REAL SQS handler (lambdas/event-handler/index.ts) and asserts the
 * accrual intent gate behaves correctly in the LIVE production path:
 *
 *   (a) financial BILL, high confidence, no existing marker → submits to QBO AND
 *       writes the CHARGE#…#INV#… dedup marker.
 *   (b) RECEIPT → does NOT submit; writes a non-booking (skipped) state.
 *   (c) BILL whose primary charge key ALREADY has a marker → skip_duplicate, no submit.
 *   (d) low-confidence / unknown → needs_review (needs_input), no submit.
 *
 * External boundaries only are mocked: DynamoDB + S3 (aws-sdk-client-mock), the
 * QBO Service HTTP calls (global.fetch), and the Stage-2 Bedrock classifier
 * (jest.mock of ./intent/classifyIntent) so no real AWS/Bedrock calls happen.
 *
 * decideBooking (Stage 3) is NOT mocked — it runs for real against the injected
 * dedup map, so this test also proves the real Stage-3 policy end-to-end.
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import type { SQSEvent, Context } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'
process.env.PROCESSED_BUCKET = 'test-processed-bucket'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'
process.env.COGNITO_TOKEN_URL = 'https://cognito.test/oauth2/token'
process.env.MACHINE_CLIENT_ID = 'test-client-id'
process.env.MACHINE_CLIENT_SECRET = 'test-client-secret'

// Mock Stage-2 (Bedrock) so we control the intent per test. decideBooking stays real.
jest.mock('../../lambdas/event-handler/intent/classifyIntent', () => ({
  classifyIntent: jest.fn(),
}))

import { CANONICAL_DOCUMENT_PROCESSED_DETAIL } from '../fixtures/documentProcessedEvent.contract'
import { handler } from '../../lambdas/event-handler/index'
import { classifyIntent } from '../../lambdas/event-handler/intent/classifyIntent'
import type { IntentResult } from '../../lambdas/event-handler/intent/types'

const classifyIntentMock = classifyIntent as jest.MockedFunction<typeof classifyIntent>

const ddbMock = mockClient(DynamoDBDocumentClient)
const ebMock = mockClient(EventBridgeClient)
const s3Mock = mockClient(S3Client)

// franz-bakery vendor rule with a deterministic qboVendorRef + wide amount range
// → booking (when intent gate says `book`) proceeds all the way to QBO submit.
const VENDOR_RULE = {
  pk: 'RULE#franz-bakery',
  sk: 'v0',
  ruleType: 'amount_range',
  config: { min: 1, max: 100000 },
  qboVendorRef: { value: '55', name: 'Franz Bakery' },
  defaultExpenseAccountRef: { value: '80', name: 'Cost of Goods Sold' },
  autoSubmit: true,
}
const VENDOR_ID = '55'

const buildSqsEvent = (detail: Record<string, unknown>): SQSEvent =>
  ({
    Records: [
      {
        messageId: 'msg-1',
        receiptHandle: 'rh-1',
        body: JSON.stringify({
          source: 'parsely.processing',
          'detail-type': 'DocumentProcessed',
          detail,
        }),
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

const invoke = (detail: Record<string, unknown>) =>
  handler(buildSqsEvent(detail), {} as Context, () => {})

const getWrittenState = (): Record<string, unknown> | undefined => {
  const statePut = ddbMock
    .commandCalls(PutCommand)
    .find((c) => (c.args[0].input as { Item?: { sk?: string } }).Item?.sk === 'state')
  return statePut?.args[0].input.Item as Record<string, unknown> | undefined
}

const getWrittenMarker = (): Record<string, unknown> | undefined => {
  const markerPut = ddbMock
    .commandCalls(PutCommand)
    .find((c) => (c.args[0].input as { Item?: { sk?: string } }).Item?.sk === 'marker')
  return markerPut?.args[0].input.Item as Record<string, unknown> | undefined
}

const purchaseWasPosted = (): boolean =>
  (global.fetch as jest.Mock).mock.calls.some(
    ([url, init]) => String(url).includes('/purchases') && init?.method === 'POST',
  )

const OAUTH_TOKEN_RESPONSE = { access_token: 'test-token', expires_in: 3600, token_type: 'Bearer' }

const installFetchMock = () => {
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/oauth2/token')) {
      return { ok: true, status: 200, json: async () => OAUTH_TOKEN_RESPONSE, text: async () => '' }
    }
    if (url.includes('/purchases')) {
      const body = { id: 'P-100', docNumber: 'DOC-100' }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
  }) as unknown as typeof fetch
}

/** Configure DynamoDB GetCommand routing. existingMarkerKey → return a marker. */
const installDdbGets = (opts: { existingMarkerKey?: string } = {}) => {
  ddbMock.on(GetCommand).callsFake((input: { Key?: { pk?: string; sk?: string } }) => {
    const { pk, sk } = input.Key ?? {}
    if (sk === 'state') return {} // idempotency miss
    if (sk === 'marker') {
      return pk === opts.existingMarkerKey
        ? { Item: { pk, sk: 'marker', qboPurchaseId: 'EXISTING-9' } }
        : {}
    }
    if (String(pk).startsWith('RULE#')) return { Item: VENDOR_RULE }
    return {} // CONFIG#defaults → fall back to defaults
  })
  ddbMock.on(PutCommand).resolves({})
}

const makeIntent = (over: Partial<IntentResult>): IntentResult => ({
  financialIntent: 'bill',
  referencedInvoiceNumbers: [],
  intentConfidence: 'high',
  intentRationale: 'test',
  ...over,
})

beforeEach(() => {
  ddbMock.reset()
  ebMock.reset()
  ebMock.on(PutEventsCommand).resolves({})
  s3Mock.reset()
  // Extracted text must be present so the handler invokes Stage 2.
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToString: async () => 'Invoice #3864339 Status: Open Balance $475.65' },
  } as never)
  classifyIntentMock.mockReset()
  installFetchMock()
})

describe('event-handler intent gate (Stage 2 + Stage 3)', () => {
  it('(a) financial BILL, high confidence, no marker → submits AND writes CHARGE# marker', async () => {
    // arrange
    installDdbGets()
    classifyIntentMock.mockResolvedValue(
      makeIntent({ financialIntent: 'bill', invoiceNumber: '3864339', intentConfidence: 'high' }),
    )

    // act
    await invoke(CANONICAL_DOCUMENT_PROCESSED_DETAIL)

    // assert — booked to QBO and recorded submitted
    const state = getWrittenState()
    expect(state?.status).toBe('submitted')
    expect(state?.qboPurchaseId).toBe('P-100')
    expect(purchaseWasPosted()).toBe(true)

    // assert — dedup marker written with the primary CHARGE#…#INV# key
    const marker = getWrittenMarker()
    expect(marker?.pk).toBe(`CHARGE#${VENDOR_ID}#INV#3864339`)
    expect(marker?.sk).toBe('marker')
    expect(marker?.qboPurchaseId).toBe('P-100')
    expect(marker?.invoiceNumber).toBe('3864339')
    expect(marker?.vendorId).toBe(VENDOR_ID)
  })

  it('(b) RECEIPT (for an already-booked invoice) → does NOT submit, writes a non-booking state', async () => {
    // arrange — receipt references invoice INV-A, whose CHARGE# marker exists →
    // Stage 3 returns `informational` (receipt_for_booked_charge) → never books.
    const bookedKey = `CHARGE#${VENDOR_ID}#INV#INV-A`
    installDdbGets({ existingMarkerKey: bookedKey })
    classifyIntentMock.mockResolvedValue(
      makeIntent({
        financialIntent: 'receipt',
        referencedInvoiceNumbers: ['INV-A'],
        intentConfidence: 'high',
      }),
    )

    // act
    await invoke(CANONICAL_DOCUMENT_PROCESSED_DETAIL)

    // assert — no QBO submit, no new marker, non-booking (skipped) state recorded
    expect(purchaseWasPosted()).toBe(false)
    expect(getWrittenMarker()).toBeUndefined()
    const state = getWrittenState()
    expect(state?.status).toBe('skipped')
  })

  it('(c) BILL whose primary charge key already has a marker → skip_duplicate, no submit', async () => {
    // arrange — the primary charge key already exists in the table
    const dupKey = `CHARGE#${VENDOR_ID}#INV#3864339`
    installDdbGets({ existingMarkerKey: dupKey })
    classifyIntentMock.mockResolvedValue(
      makeIntent({ financialIntent: 'bill', invoiceNumber: '3864339', intentConfidence: 'high' }),
    )

    // act
    await invoke(CANONICAL_DOCUMENT_PROCESSED_DETAIL)

    // assert — duplicate detected: no submit, skipped state referencing the existing purchase
    expect(purchaseWasPosted()).toBe(false)
    expect(getWrittenMarker()).toBeUndefined()
    const state = getWrittenState()
    expect(state?.status).toBe('skipped')
    expect(String(state?.failureReason)).toContain('EXISTING-9')
  })

  it('(d) low-confidence / unknown → needs_review (needs_input), no submit', async () => {
    // arrange
    installDdbGets()
    classifyIntentMock.mockResolvedValue(
      makeIntent({ financialIntent: 'unknown', intentConfidence: 'low' }),
    )

    // act
    await invoke(CANONICAL_DOCUMENT_PROCESSED_DETAIL)

    // assert — routed to human review, nothing submitted or marked
    expect(purchaseWasPosted()).toBe(false)
    expect(getWrittenMarker()).toBeUndefined()
    const state = getWrittenState()
    expect(state?.status).toBe('needs_input')
  })
})
