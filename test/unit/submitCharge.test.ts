/**
 * UNIT TESTS — shared `submitCharge` booking primitive (BDK #2)
 * ────────────────────────────────────────────────────────────────────────────
 * Boundaries only are mocked: DynamoDB (aws-sdk-client-mock), the QBO Service
 * HTTP call (injected fetchImpl), getAuthToken + attachPdf (injected deps).
 *
 * Covers:
 *   - success (2xx) → status submitted + reserves, then finalizes, the CHARGE# marker
 *   - 409 → `duplicate` (never a new booking) surfacing the EXISTING purchase id/docNumber
 *   - marker already held → `duplicate` without any QBO call; override bypasses the reservation
 *   - stale (orphaned) reservations are taken over; fresh ones are respected
 *   - non-2xx → failed + error + intuitTid captured, reservation released
 *   - attach failure → attachmentFailed, booking still intact (status submitted)
 *   - no chargeKey → no marker write
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { submitCharge, SubmitChargeDeps } from '../../lambdas/shared/booking/submitCharge'
import { installFakeTable } from '../helpers/fakeTable'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const QBO_URL = 'https://qbo-service.test'
const TABLE = 'test-expense-table'

/** Build a fake Response-like object with a controllable status/body/headers. */
const makeResponse = (opts: { status: number; body?: unknown; intuitTid?: string }): Response => {
  const bodyStr = JSON.stringify(opts.body ?? {})
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    json: async () => opts.body ?? {},
    text: async () => bodyStr,
    headers: {
      get: (k: string) => (k === 'intuit_tid' ? (opts.intuitTid ?? null) : null),
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

let table: ReturnType<typeof installFakeTable>

/** The first marker in the table (undefined when none — e.g. a released reservation). */
const getMarker = (): Record<string, unknown> | undefined =>
  [...table.store.values()].find((i) => i.sk === 'marker')

beforeEach(() => {
  ddbMock.reset()
  table = installFakeTable(ddbMock)
})

describe('submitCharge', () => {
  it('success (2xx) → submitted and writes the CHARGE# marker', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        makeResponse({ status: 200, body: { id: 'P-1', docNumber: 'D-1' } }),
      ) as unknown as typeof fetch

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

    expect(result).toMatchObject({
      success: true,
      status: 'submitted',
      qboPurchaseId: 'P-1',
      qboDocNumber: 'D-1',
    })

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

  it('409 → duplicate (not a booking) surfacing the EXISTING purchase id/docNumber', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
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
      success: false,
      status: 'duplicate',
      duplicateSource: 'qbo',
      qboPurchaseId: 'EXISTING-9',
      qboDocNumber: 'DOC-9',
    })
    // Marker still recorded against the existing purchase.
    expect(getMarker()?.qboPurchaseId).toBe('EXISTING-9')
  })

  it('non-2xx → failed with error + intuitTid captured, no marker', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        makeResponse({ status: 400, body: 'bad request', intuitTid: 'tid-abc' }),
      ) as unknown as typeof fetch

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
    expect(result.errorCode).toBeUndefined()
    // Failed booking → the reservation is released, NO marker remains.
    expect(getMarker()).toBeUndefined()
  })

  it('401 QBO_AUTH_EXPIRED body → failed, surfaces errorCode + body intuitTid', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      makeResponse({
        status: 401,
        body: { error: { code: 'QBO_AUTH_EXPIRED', message: 'expired' }, intuitTid: 'tid-401' },
      }),
    ) as unknown as typeof fetch

    const result = await submitCharge(
      {
        qboPayload: {},
        documentId: 'DOC-401',
        chargeKey: 'CHARGE#55#INV#INV-401',
        vendorId: '55',
        invoiceNumber: 'INV-401',
      },
      ddb,
      baseDeps(fetchImpl),
    )

    expect(result.success).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.errorCode).toBe('QBO_AUTH_EXPIRED')
    expect(result.intuitTid).toBe('tid-401')
    // Failed booking → the reservation is released, NO marker remains.
    expect(getMarker()).toBeUndefined()
  })

  it('non-JSON error body → failed with no errorCode (tolerated)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '<html>Unauthorized</html>',
      headers: { get: () => null },
    }) as unknown as typeof fetch

    const result = await submitCharge(
      { qboPayload: {}, documentId: 'DOC-X' },
      ddb,
      baseDeps(fetchImpl),
    )

    expect(result.success).toBe(false)
    expect(result.errorCode).toBeUndefined()
  })

  it('attach failure → attachmentFailed but booking intact (submitted)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        makeResponse({ status: 200, body: { id: 'P-4', docNumber: 'D-4' } }),
      ) as unknown as typeof fetch

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
      .mockResolvedValue(
        makeResponse({ status: 200, body: { id: 'P-5', docNumber: 'D-5' } }),
      ) as unknown as typeof fetch

    const result = await submitCharge(
      { qboPayload: {}, documentId: 'DOC-5' },
      ddb,
      baseDeps(fetchImpl),
    )

    expect(result.success).toBe(true)
    expect(getMarker()).toBeUndefined()
  })

  describe('reservation', () => {
    const input = {
      qboPayload: {},
      documentId: 'DOC-R',
      chargeKey: 'CHARGE#55#INV#INV-R',
      vendorId: '55',
      invoiceNumber: 'INV-R',
    }
    const ok = () =>
      jest
        .fn()
        .mockResolvedValue(
          makeResponse({ status: 200, body: { id: 'P-R', docNumber: 'D-R' } }),
        ) as unknown as typeof fetch

    it('marker already booked → duplicate from the marker, QBO never called', async () => {
      table.put({ pk: input.chargeKey, sk: 'marker', documentId: 'OTHER', qboPurchaseId: 'P-OLD' })
      const fetchImpl = ok()

      const result = await submitCharge(input, ddb, baseDeps(fetchImpl))

      expect(result).toMatchObject({
        status: 'duplicate',
        duplicateSource: 'marker',
        qboPurchaseId: 'P-OLD',
      })
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('fresh in-flight reservation is respected (duplicate, no purchase id yet)', async () => {
      table.put({
        pk: input.chargeKey,
        sk: 'marker',
        documentId: 'OTHER',
        reservedAt: new Date().toISOString(),
      })
      const fetchImpl = ok()

      const result = await submitCharge(input, ddb, baseDeps(fetchImpl))

      expect(result).toMatchObject({ status: 'duplicate', duplicateSource: 'marker' })
      expect(result.qboPurchaseId).toBeUndefined()
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('stale (orphaned) reservation is taken over', async () => {
      table.put({
        pk: input.chargeKey,
        sk: 'marker',
        documentId: 'CRASHED',
        reservedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      })

      const result = await submitCharge(input, ddb, baseDeps(ok()))

      expect(result.status).toBe('submitted')
      expect(getMarker()).toMatchObject({ documentId: 'DOC-R', qboPurchaseId: 'P-R' })
    })

    it('override bypasses the reservation but never clobbers a booked marker', async () => {
      table.put({ pk: input.chargeKey, sk: 'marker', documentId: 'OTHER', qboPurchaseId: 'P-OLD' })
      const fetchImpl = ok()

      const result = await submitCharge({ ...input, override: true }, ddb, baseDeps(fetchImpl))

      expect(result.status).toBe('submitted')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(getMarker()?.qboPurchaseId).toBe('P-OLD')
    })
  })
})
