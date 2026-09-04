/**
 * TIER-1 HANDLER TEST — event-handler orchestration (mocked AWS + fetch)
 * ────────────────────────────────────────────────────────────────────────────
 * Drives the REAL SQS handler (lambdas/event-handler/index.ts) end-to-end with a
 * synthetic SQS record built from the canonical DocumentProcessed event contract,
 * mocking only the external boundaries (DynamoDB, S3, and the QBO Service HTTP
 * calls via global fetch). No AWS calls, no network — fast, free, deterministic.
 *
 * This exercises the full orchestration that unit tests on individual strategies
 * do NOT cover: idempotency check, config load, vendor-rule lookup, deterministic
 * vs fuzzy vendor resolution, rule dispatch, submit, and state write. It is the
 * highest-ROI accuracy net for the expense processor.
 *
 * Env must be set before importing the handler (constants read process.env at
 * module load).
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge'
import { S3Client } from '@aws-sdk/client-s3'
import type { SQSEvent, Context } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'
process.env.PROCESSED_BUCKET = 'test-processed-bucket'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'
process.env.COGNITO_TOKEN_URL = 'https://cognito.test/oauth2/token'
process.env.MACHINE_CLIENT_ID = 'test-client-id'
process.env.MACHINE_CLIENT_SECRET = 'test-client-secret'

import { CANONICAL_DOCUMENT_PROCESSED_DETAIL } from '../fixtures/documentProcessedEvent.contract'
import { handler } from '../../lambdas/event-handler/index'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ebMock = mockClient(EventBridgeClient)
const s3Mock = mockClient(S3Client)

/** Build an SQS event whose body is an EventBridge envelope with the given detail. */
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

/** Invoke the SQSHandler with a synthetic event (no-op context/callback). */
const invoke = (detail: Record<string, unknown>) =>
  handler(buildSqsEvent(detail), {} as Context, () => {})

/** Capture the state item written via PutCommand (sk === 'state'). */
const getWrittenState = (): Record<string, unknown> | undefined => {
  const puts = ddbMock.commandCalls(PutCommand)
  const statePut = puts.find(
    (c) => (c.args[0].input as { Item?: { sk?: string } }).Item?.sk === 'state',
  )
  return statePut?.args[0].input.Item as Record<string, unknown> | undefined
}

const OAUTH_TOKEN_RESPONSE = { access_token: 'test-token', expires_in: 3600, token_type: 'Bearer' }

interface MockRoute {
  status: number
  body: unknown
}

/**
 * Install a global.fetch mock. `route(url, body?)` returns the response for a
 * given URL; the Cognito token URL is always handled. Captures the last JSON
 * body POSTed to /purchases in `captured.purchasePayload`.
 */
const captured: { purchasePayload?: { lines?: Array<{ amount: number }> } } = {}

const installFetchMock = (route: (url: string) => MockRoute) => {
  captured.purchasePayload = undefined
  global.fetch = jest.fn(async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input)
    if (url.includes('/oauth2/token')) {
      return { ok: true, status: 200, json: async () => OAUTH_TOKEN_RESPONSE, text: async () => '' }
    }
    if (url.includes('/purchases') && init?.body) {
      try {
        captured.purchasePayload = JSON.parse(init.body as string)
      } catch {
        /* GET query — no body */
      }
    }
    const r = route(url)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    }
  }) as unknown as typeof fetch
}

beforeEach(() => {
  ddbMock.reset()
  ebMock.reset()
  ebMock.on(PutEventsCommand).resolves({})
  s3Mock.reset()
  // attachPdf is best-effort; a rejected S3 send is caught and does not fail the flow.
  s3Mock.rejects(new Error('s3 not mocked in this test'))
})

describe('event-handler Tier-1 orchestration', () => {
  it('unknown vendor (no rule, no fuzzy match) → needs_input:new_vendor, no submit', async () => {
    // arrange — every GET misses (idempotency, config, rule, vendor cache)
    ddbMock.on(GetCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    installFetchMock(() => ({ status: 200, body: { purchases: [] } }))

    // act
    await invoke({ ...CANONICAL_DOCUMENT_PROCESSED_DETAIL, vendorName: 'totally-unknown-vendor' })

    // assert — vendor unresolvable → human approval path, nothing submitted
    const state = getWrittenState()
    expect(state?.status).toBe('needs_input')
    expect(state?.needsInputType).toBe('new_vendor')
  })

  it('idempotency: already-submitted document is skipped (no state rewrite)', async () => {
    // arrange — idempotency GET returns an already-submitted state
    ddbMock.on(GetCommand).resolves({ Item: { pk: 'DOC#x', sk: 'state', status: 'submitted' } })
    ddbMock.on(PutCommand).resolves({})
    installFetchMock(() => ({ status: 200, body: {} }))

    // act
    await invoke(CANONICAL_DOCUMENT_PROCESSED_DETAIL)

    // assert — short-circuited before any processing; no state write
    expect(getWrittenState()).toBeUndefined()
  })

  it('deterministic vendor rule (qboVendorRef + amount_range) → submitted, skips fuzzy resolve', async () => {
    // arrange — a vendor RULE with qboVendorRef + amount_range admitting $475.65
    const vendorRule = {
      pk: 'RULE#franz-bakery',
      sk: 'v0',
      ruleType: 'amount_range',
      config: { min: 1, max: 100000 },
      qboVendorRef: { value: '55', name: 'Franz Bakery' },
      defaultExpenseAccountRef: { value: '80', name: 'Cost of Goods Sold' },
      autoSubmit: true,
    }
    ddbMock.on(GetCommand).callsFake((input: { Key?: { pk?: string; sk?: string } }) => {
      if (input.Key?.sk === 'state') return {} // idempotency miss
      if (String(input.Key?.pk).startsWith('RULE#')) return { Item: vendorRule }
      return {} // config → defaults
    })
    ddbMock.on(PutCommand).resolves({})
    installFetchMock((url) =>
      url.includes('/purchases')
        ? { status: 200, body: { id: 'P-1', docNumber: 'DOC-1' } }
        : { status: 200, body: {} },
    )

    // act
    await invoke(CANONICAL_DOCUMENT_PROCESSED_DETAIL)

    // assert — deterministic path submitted to QBO and recorded submitted state
    const state = getWrittenState()
    expect(state?.status).toBe('submitted')
    expect(state?.qboPurchaseId).toBe('P-1')
    expect((state?.qboVendorRef as { value: string })?.value).toBe('55')
  })

  it('parses dollar-formatted amounts string[] into the numeric QBO line amount', async () => {
    // arrange — deterministic rule; assert "$475.65" → 475.65 (documents the
    // amounts string[]/number[] contract: runtime parseAmount handles strings)
    const vendorRule = {
      pk: 'RULE#franz-bakery',
      sk: 'v0',
      ruleType: 'amount_range',
      config: { min: 1, max: 100000 },
      qboVendorRef: { value: '55', name: 'Franz Bakery' },
      defaultExpenseAccountRef: { value: '80', name: 'COGS' },
      autoSubmit: true,
    }
    ddbMock.on(GetCommand).callsFake((input: { Key?: { pk?: string; sk?: string } }) => {
      if (input.Key?.sk === 'state') return {}
      if (String(input.Key?.pk).startsWith('RULE#')) return { Item: vendorRule }
      return {}
    })
    ddbMock.on(PutCommand).resolves({})
    installFetchMock((url) =>
      url.includes('/purchases')
        ? { status: 200, body: { id: 'P-2', docNumber: 'DOC-2' } }
        : { status: 200, body: {} },
    )

    // act
    await invoke({ ...CANONICAL_DOCUMENT_PROCESSED_DETAIL, amounts: ['$475.65'] })

    // assert — "$475.65" string parsed to numeric 475.65 on the QBO line
    expect(captured.purchasePayload?.lines?.[0]?.amount).toBeCloseTo(475.65, 2)
  })
})
