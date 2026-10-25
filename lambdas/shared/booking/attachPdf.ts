/**
 * SHARED ATTACHMENT PRIMITIVE — `attachPdf`
 * ────────────────────────────────────────────────────────────────────────────
 * The single code path that attaches a source PDF to a QBO purchase. Both the
 * automated event-handler AND the human-initiated API handlers (setAccount /
 * correctAndSubmit) use it so that attachment behaviour is identical regardless
 * of booking path.
 *
 * It downloads the PDF from S3 (`s3://bucket/key`), base64-encodes it, and POSTs
 * it to the QBO Service `/purchases/{purchaseId}/attachments` endpoint with a
 * Bearer token. The QBO Service URL + auth-token helper are INJECTED (mirroring
 * how {@link submitCharge} injects its deps) so this module carries no
 * handler-specific imports and each Lambda keeps its own container-cached
 * `getAuthToken`.
 *
 * Best-effort by contract: it never throws — any failure is returned as
 * `{ success: false, error }` so a caller's booking is never rolled back by an
 * attachment problem.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

const s3Client = new S3Client({})

export interface AttachPdfDeps {
  /** Returns a valid Bearer token for the QBO Service. */
  getAuthToken: () => Promise<string>
  /** The QBO Service base URL (e.g. https://qbo-service.test). */
  qboServiceUrl: string
  /** Injectable S3 client (defaults to a module-scoped singleton). */
  s3?: S3Client
  /** Injectable fetch (defaults to the global). */
  fetchImpl?: typeof fetch
}

/**
 * Download the source PDF from S3 and attach it to the QBO purchase. Returns a
 * normalized result; never throws.
 */
export const attachPdf = async (
  purchaseId: string,
  originalUri: string,
  deps: AttachPdfDeps,
): Promise<{ success: boolean; error?: string }> => {
  const s3 = deps.s3 ?? s3Client
  const doFetch = deps.fetchImpl ?? fetch
  try {
    // Download PDF from S3
    const { bucket, key } = parseS3Uri(originalUri)
    const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))

    const bytes = await s3Response.Body?.transformToByteArray()
    if (!bytes) {
      return { success: false, error: 'Empty file body from S3' }
    }

    // Determine filename from key
    const fileName = key.split('/').pop() || 'receipt.pdf'

    // Call QBO Service attachments endpoint
    const token = await deps.getAuthToken()
    const response = await doFetch(`${deps.qboServiceUrl}/purchases/${purchaseId}/attachments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fileName,
        contentType: 'application/pdf',
        content: Buffer.from(bytes).toString('base64'),
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      return { success: false, error: `Attachment upload failed: ${response.status} ${errorBody}` }
    }

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: message }
  }
}

const parseS3Uri = (uri: string): { bucket: string; key: string } => {
  const withoutProtocol = uri.replace('s3://', '')
  const slashIndex = withoutProtocol.indexOf('/')
  return {
    bucket: withoutProtocol.slice(0, slashIndex),
    key: withoutProtocol.slice(slashIndex + 1),
  }
}
