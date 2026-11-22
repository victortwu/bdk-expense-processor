/**
 * `POST /expenses/from-document/{documentId}` — a HUMAN opens (or creates) the expense of any
 * Parsely document, whatever its type (BDK #13). Idempotent open-or-create: an existing DOC#
 * item is returned untouched; otherwise a `needs_input`/`review` item owned by the human is seeded
 * from the document. Never calls QBO — booking is the separate correct-and-submit action.
 */
import { expenseRepo } from '../../shared/expense/expenseRepo'
import { ExpenseStatus } from '../../shared/expense/status'
import { ExpenseState } from '../../shared/expense/types'
import { ApiError, ApiHandler, respond } from '../../shared/http/respond'
import { docKey } from '../../shared/keys'
import { getParselyDocument } from '../../shared/parsely/getParselyDocument'
import { logger } from '../../shared/utils/logger'
import { TABLE_NAME } from '../constants'

/** Parsely document ids are ULIDs/UUIDs; anything else (e.g. `..`) never reaches the upstream URL. */
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const notFound = (documentId: string) =>
  new ApiError(404, `Document not found: ${documentId}`, { error: 'DOCUMENT_NOT_FOUND' })

export const createExpenseFromDocument: ApiHandler = async (event, ddb) => {
  const documentId = event.pathParameters?.documentId
  if (!documentId || !DOCUMENT_ID_PATTERN.test(documentId)) {
    throw new ApiError(400, 'A valid documentId path parameter is required')
  }

  // A user token carries its tenant. Only OUR machine client may omit it (Parsely then scopes by
  // the machine token's tenant); any other tenant-less token is refused, never treated as "any".
  const { 'custom:tenantId': callerTenant, client_id: clientId } =
    event.requestContext.authorizer.jwt.claims
  if (!callerTenant && (!clientId || clientId !== process.env.MACHINE_CLIENT_ID)) {
    throw new ApiError(403, 'Token has no tenant')
  }
  const visibleToCaller = (tenantId: string) => !callerTenant || callerTenant === tenantId

  const repo = expenseRepo(ddb, TABLE_NAME)
  const existing = await repo.get(documentId)
  if (existing) {
    if (!visibleToCaller(existing.tenantId)) throw notFound(documentId)
    return respond(200, { created: false, expense: existing })
  }

  let doc
  try {
    doc = await getParselyDocument(documentId)
  } catch (err) {
    logger.error('Parsely document fetch failed', { documentId, err })
    throw new ApiError(502, 'Parsely is unavailable — try again shortly', {
      error: 'PARSELY_UNAVAILABLE',
    })
  }
  if (!doc || !visibleToCaller(doc.tenantId)) throw notFound(documentId)

  const now = new Date().toISOString()
  const expense: ExpenseState = {
    ...docKey(documentId),
    tenantId: doc.tenantId,
    documentId,
    status: ExpenseStatus.NeedsInput,
    needsInputType: 'review',
    bookingOwner: 'human',
    vendorName: doc.vendorName || 'unknown',
    vendorDisplay: doc.vendorDisplay,
    documentDate: doc.documentDate || '',
    amounts: doc.amounts ?? [],
    description: doc.description,
    originalUri: doc.originalUri,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }

  if (await repo.createIfAbsent(expense)) return respond(201, { created: true, expense })

  // Lost a race with another tab (or the pipeline): the winner's item is the answer.
  const winner = await repo.get(documentId)
  if (!winner) throw new ApiError(500, 'Failed to create expense')
  return respond(200, { created: false, expense: winner })
}
