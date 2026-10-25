/**
 * UNIT TESTS — shared `attachPdf` primitive (BDK #7)
 * ────────────────────────────────────────────────────────────────────────────
 * Boundaries only are mocked: S3 GetObject (aws-sdk-client-mock), the QBO Service
 * HTTP call (injected fetchImpl), getAuthToken (injected dep). The module never
 * throws — every failure returns `{ success: false, error }` so a caller's
 * booking is never rolled back by an attachment problem.
 *
 * Covers:
 *   - success (2xx) → { success: true }, POSTs base64 PDF to the attachments route
 *   - non-2xx → { success: false } (does not throw)
 *   - empty S3 body → { success: false } (no fetch attempted)
 */
import { mockClient } from 'aws-sdk-client-mock'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { attachPdf, AttachPdfDeps } from '../../lambdas/shared/booking/attachPdf'

const s3Mock = mockClient(S3Client)

const QBO_URL = 'https://qbo-service.test'
const URI = 's3://processed-bucket/documents/tenant/doc/original.pdf'

const makeResponse = (status: number, body = ''): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }) as unknown as Response

const baseDeps = (fetchImpl: typeof fetch, over: Partial<AttachPdfDeps> = {}): AttachPdfDeps => ({
  getAuthToken: jest.fn().mockResolvedValue('test-token'),
  qboServiceUrl: QBO_URL,
  fetchImpl,
  ...over,
})

beforeEach(() => {
  s3Mock.reset()
  jest.clearAllMocks()
})

describe('shared attachPdf', () => {
  test('success → { success: true } and POSTs the base64 PDF to the attachments route', async () => {
    // arrange
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3, 4]) },
    } as never)
    const fetchImpl = jest.fn(async () => makeResponse(200)) as unknown as typeof fetch

    // act
    const result = await attachPdf('P-1', URI, baseDeps(fetchImpl))

    // assert
    expect(result).toEqual({ success: true })
    const spy = fetchImpl as unknown as jest.Mock
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0]
    expect(url).toBe('https://qbo-service.test/purchases/P-1/attachments')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
    const payload = JSON.parse(init.body as string)
    expect(payload.fileName).toBe('original.pdf')
    expect(payload.contentType).toBe('application/pdf')
    expect(payload.content).toBe(Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64'))
  })

  test('non-2xx → { success: false } (never throws)', async () => {
    // arrange
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => new Uint8Array([9]) },
    } as never)
    const fetchImpl = jest.fn(async () => makeResponse(500, 'boom')) as unknown as typeof fetch

    // act
    const result = await attachPdf('P-2', URI, baseDeps(fetchImpl))

    // assert
    expect(result.success).toBe(false)
    expect(result.error).toContain('500')
  })

  test('empty S3 body → { success: false } and no fetch attempted', async () => {
    // arrange
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => undefined },
    } as never)
    const fetchImpl = jest.fn(async () => makeResponse(200)) as unknown as typeof fetch

    // act
    const result = await attachPdf('P-3', URI, baseDeps(fetchImpl))

    // assert
    expect(result.success).toBe(false)
    expect(result.error).toBe('Empty file body from S3')
    expect(fetchImpl as unknown as jest.Mock).not.toHaveBeenCalled()
  })
})
