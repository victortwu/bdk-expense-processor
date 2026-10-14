/**
 * UNIT TESTS — shared `submitCharge` booking primitive (BDK #2)
 * ────────────────────────────────────────────────────────────────────────────
 * Boundaries only are mocked: DynamoDB (aws-sdk-client-mock), the QBO Service
 * HTTP call (injected fetchImpl), getAuthToken + attachPdf (injected deps).
 *
 * Covers:
 *   - success (2xx) → status submitted + writes the CHARGE# marker
 *   - 409 → success + surfaces the EXISTING purchase id/docNumber
 *   - non-2xx → failed + error + intuitTid captured
 *   - attach failure → attachmentFailed, booking still intact (status submitted)
 *   - no chargeKey → no marker write
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import { submitCharge, SubmitChargeDeps } from '../../lambdas/shared/booking/submitCharge'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const QBO_URL = 'https://qbo-service.test'
const TABLE = 'test-expense-table'

/** Build a fake Response-like object with a controllable status/body/headers. */
const makeResponse = (opts: {
  status: number
  body?: unknown
  intuitTid?: string
}): Response => {
  const bodyStr = JSON.stringify(opts.body ?? {})
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    json: async () => opts.body ?? {},
    text: async () => bodyStr,
    headers: {
      get: (k: string) => (k === 'intuit_tid' ? opts.intuitTid ?? null : null),
    },
  } as unknown as Response
}

const baseDeps = (
  fetchImpl: typeof fetch,
  over: Partial<SubmitChargeDeps> = {},
): SubmitChargeDeps => ({
  getAuthToken: jest.fn().mockResolvedValue('test-token'),
  qboServiceUrl: QBO_URL,
  tableName: TABLE,
  fetchImpl,
  ...over,
})

const getMarker = (): Record<string, unknown> | undefined => {
  const put = ddbMock
    .commandCalls(PutCommand)
    .find((c) => (c.args[0].input as { Item?: { sk?: string } }).Item?.sk === 'marker')
  return put?.args[0].input.Item as Record<string, unknown> | undefined
}

beforeEach(() => {
  ddbMock.reset()
  ddbMock.on(PutCommand).resolves({})
})

describe('submitCharge', () => {
  it('success (2xx) → submitted and writes the CHARGE# marker', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, body: { id: 'P-1', docNumber: 'D-1' } })) as unknown as typeof fetch

    const result = await submitCharge(
      {
        qboPayload: { foo: 'bar' },
        documentId: 'DOC-1',
        chargeKey: 'CHARGE#55#INV#INV-1',
        vendorId: '55',
        invoiceNumber: 'INV-1',
        amount: 123.45,
        documentDate: '2026-01-02',
      },
      ddb,
      baseDeps(fetchImpl),
    )

    expect(result).toMatchObject({ success: true, status: 'submitted', qboPurchaseId: 'P-1', qboDocNumber: 'D-1' })

    // POSTed to /purchases with Bearer
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0]
    expect(url).toBe(`${QBO_URL}/purchases`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token')

    // Marker written with the exact shape.
    const marker = getMarker()
    expect(marker).toBeDefined()
    expect(marker?.pk).toBe('CHARGE#55#INV#INV-1')
    expect(marker?.sk).toBe('marker')
    expect(marker?.qboPurchaseId).toBe('P-1')
    expect(marker?.invoiceNumber).toBe('INV-1')
    expect(marker?.vendorId).toBe('55')
    expect(marker?.amount).toBe(123.45)
    expect(marker?.documentDate).toBe('2026-01-02')
  })

  it('409 → success surfacing the EXISTING purchase id/docNumber', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      makeResponse({ status: 409, body: { existing: { id: 'EXISTING-9', docNumber: 'DOC-9' } } }),
    ) as unknown as typeof fetch

    const result = await submitCharge(
      {
        qboPayload: {},
        documentId: 'DOC-2',
        chargeKey: 'CHARGE#55#INV#INV-9',
        vendorId: '55',
        invoiceNumber: 'INV-9',
      },
      ddb,
      baseDeps(fetchImpl),
    )

    expect(result).toMatchObject({
      success: true,
      status: 'submitted',
      qboPurchaseId: 'EXISTING-9',
      qboDocNumber: 'DOC-9',
    })
    // Marker still recorded against the existing purchase.
    expect(getMarker()?.qboPurchaseId).toBe('EXISTING-9')
  })

  it('non-2xx → failed with error + intuitTid captured, no marker', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 400, body: 'bad request', intuitTid: 'tid-abc' })) as unknown as typeof fetch

    const result = await submitCharge(
      {
        qboPayload: {},
        documentId: 'DOC-3',
        chargeKey: 'CHARGE#55#INV#INV-3',
        vendorId: '55',
        invoiceNumber: 'INV-3',
      },
      ddb,
      baseDeps(fetchImpl),
    )

    expect(result.success).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('QBO API error 400')
    expect(result.intuitTid).toBe('tid-abc')
    // Failed booking → NO marker.
    expect(getMarker()).toBeUndefined()
  })

  it('attach failure → attachmentFailed but booking intact (submitted)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, body: { id: 'P-4', docNumber: 'D-4' } })) as unknown as typeof fetch

    const attachPdf = jest.fn().mockResolvedValue({ success: false, error: 's3 denied' })

    const result = await submitCharge(
      {
        qboPayload: {},
        documentId: 'DOC-4',
        chargeKey: 'CHARGE#55#INV#INV-4',
        vendorId: '55',
        invoiceNumber: 'INV-4',
        originalUri: 's3://bucket/key/original.pdf',
      },
      ddb,
      baseDeps(fetchImpl, { attachPdf }),
    )

    expect(result.success).toBe(true)
    expect(result.status).toBe('submitted')
    expect(result.qboPurchaseId).toBe('P-4')
    expect(result.attachmentFailed).toBe(true)
    expect(result.attachmentUploaded).toBeUndefined()
    expect(attachPdf).toHaveBeenCalledWith('P-4', 's3://bucket/key/original.pdf')
    // Marker still written despite attach failure.
    expect(getMarker()?.qboPurchaseId).toBe('P-4')
  })

  it('no chargeKey → no marker write', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, body: { id: 'P-5', docNumber: 'D-5' } })) as unknown as typeof fetch

    const result = await submitCharge(
      { qboPayload: {}, documentId: 'DOC-5' },
      ddb,
      baseDeps(fetchImpl),
    )

    expect(result.success).toBe(true)
    expect(getMarker()).toBeUndefined()
  })
})
