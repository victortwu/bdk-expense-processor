import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { QBO_SERVICE_URL } from '../constants'

const s3Client = new S3Client({})

export const attachPdf = async (
  purchaseId: string,
  originalUri: string,
): Promise<{ success: boolean; error?: string }> => {
  try {
    // Download PDF from S3
    const { bucket, key } = parseS3Uri(originalUri)
    const s3Response = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    )

    const bytes = await s3Response.Body?.transformToByteArray()
    if (!bytes) {
      return { success: false, error: 'Empty file body from S3' }
    }

    // Determine filename from key
    const fileName = key.split('/').pop() || 'receipt.pdf'

    // Call QBO Service attachments endpoint
    const response = await fetch(`${QBO_SERVICE_URL}/purchases/${purchaseId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName,
        contentType: 'application/pdf',
        fileBytes: Buffer.from(bytes).toString('base64'),
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
