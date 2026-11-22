import { getAuthToken } from '../auth/getAuthToken'
import { PARSELY_API_URL } from '../config'

const TIMEOUT_MS = 10_000

/** The fields of a Parsely document record that an expense is seeded from. */
export interface ParselyDocument {
  tenantId: string
  documentId: string
  vendorName?: string
  vendorDisplay?: string
  documentDate?: string
  amounts?: string[]
  description?: string
  originalUri?: string
}

/**
 * `GET /documents/{id}` on Parsely with the machine token. The token's tenant scopes the lookup,
 * so a document of another tenant is simply "not found". Returns `undefined` for 404; any other
 * non-2xx (or a network/token failure) throws so the caller can report the upstream as unavailable (a malformed body counts as such).
 */
export const getParselyDocument = async (
  documentId: string,
): Promise<ParselyDocument | undefined> => {
  const response = await fetch(`${PARSELY_API_URL}/documents/${encodeURIComponent(documentId)}`, {
    headers: { Authorization: `Bearer ${await getAuthToken()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`Parsely GET /documents failed (${response.status})`)
  const doc = (await response.json()) as Partial<ParselyDocument>
  if (typeof doc.tenantId !== 'string' || doc.documentId !== documentId) {
    throw new Error('Parsely returned an unexpected document')
  }
  return doc as ParselyDocument
}
