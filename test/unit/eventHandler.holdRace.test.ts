/**
 * Handler-level lost write: the state write is REJECTED (a human-owned hold, or a terminal state,
 * won the race after the handler's read). The handler must neither notify nor book for an item
 * it did not write — on every branch that writes state (new vendor, intent gate, main path).
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

jest.mock('../../lambdas/event-handler/intent/classifyIntent', () => ({
  classifyIntent: jest.fn(),
}))

import { CANONICAL_DOCUMENT_PROCESSED_DETAIL } from '../fixtures/documentProcessedEvent.contract'
import { handler } from '../../lambdas/event-handler/index'
import { classifyIntent } from '../../lambdas/event-handler/intent/classifyIntent'

const classifyIntentMock = classifyIntent as jest.MockedFunction<typeof classifyIntent>
const ddbMock = mockClient(DynamoDBDocumentClient)
const ebMock = mockClient(EventBridgeClient)
const s3Mock = mockClient(S3Client)

const VENDOR_RULE = {
  pk: 'RULE#franz-bakery',
  sk: 'v0',
  ruleType: 'amount_range',
  config: { min: 1, max: 100000 },
  qboVendorRef: { value: '55', name: 'Franz Bakery' },
  defaultExpenseAccountRef: { value: '80', name: 'Cost of Goods Sold' },
  autoSubmit: true,
}

const sqsEvent = (detail: Record<string, unknown>): SQSEvent =>
  ({
    Records: [
      {
        messageId: 'm',
        receiptHandle: 'r',
        body: JSON.stringify({ source: 'parsely.processing', 'detail-type': 'DocumentProcessed', detail }),
        attributes: {},
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-west-2:0:t',
        awsRegion: 'us-west-2',
      },
    ],
  }) as unknown as SQSEvent

const invoke = (detail: Record<string, unknown>) =>
  handler(sqsEvent(detail), {} as Context, () => {})

/** The handler read no item (race window) and every state write is then rejected by its condition. */
const stateWritesRejected = (opts: { withRule: boolean }) => {
  ddbMock.on(GetCommand).callsFake((input: { Key?: { pk?: string; sk?: string } }) => {
    const { pk, sk } = input.Key ?? {}
    if (opts.withRule && String(pk).startsWith('RULE#')) return { Item: VENDOR_RULE }
    return sk === 'state' || sk === 'marker' ? {} : {}
  })
  ddbMock
    .on(PutCommand)
    .rejects(Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' }))
}

const purchasePosted = () =>
  (global.fetch as jest.Mock).mock.calls.some(([url]) => String(url).includes('/purchases'))

beforeEach(() => {
  ddbMock.reset()
  ebMock.reset()
  ebMock.on(PutEventsCommand).resolves({})
  s3Mock.reset()
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToString: async () => 'Invoice #1 Status: Open Balance $475.65' },
  } as never)
  classifyIntentMock.mockReset()
  global.fetch = jest.fn(async (input: unknown) => {
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    return String(input).includes('/oauth2/token')
      ? ok({ access_token: 't', expires_in: 3600, token_type: 'Bearer' })
      : ok({ purchases: [] })
  }) as unknown as typeof fetch
})

describe('event-handler: a rejected state write is final (no notification, no booking)', () => {
  it('new-vendor branch', async () => {
    stateWritesRejected({ withRule: false })

    await invoke({ ...CANONICAL_DOCUMENT_PROCESSED_DETAIL, vendorName: 'totally-unknown-vendor' })

    expect(ddbMock.commandCalls(PutCommand).length).toBeGreaterThan(0)
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0)
    expect(purchasePosted()).toBe(false)
  })

  it('intent-gate branch (needs_review)', async () => {
    stateWritesRejected({ withRule: true })
    classifyIntentMock.mockResolvedValue({
      financialIntent: 'unknown',
      referencedInvoiceNumbers: [],
      intentConfidence: 'low',
      intentRationale: 'test',
    })

    await invoke(CANONICAL_DOCUMENT_PROCESSED_DETAIL)

    expect(ddbMock.commandCalls(PutCommand).length).toBeGreaterThan(0)
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0)
    expect(purchasePosted()).toBe(false)
  })

  it('main path (create race lost, replace rejected): no notification, no QBO booking', async () => {
    stateWritesRejected({ withRule: true })
    classifyIntentMock.mockResolvedValue({
      financialIntent: 'bill',
      invoiceNumber: 'INV-1',
      referencedInvoiceNumbers: [],
      intentConfidence: 'high',
      intentRationale: 'test',
    })

    await invoke(CANONICAL_DOCUMENT_PROCESSED_DETAIL)

    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0)
    expect(purchasePosted()).toBe(false)
  })
})
