import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { logger } from '../utils/logger'

// Cache records live in the expense table as { pk, sk, <field>: T[], refreshedAt }.
// approveVendor invalidates the vendors record by setting refreshedAt to the past.
export const QBO_VENDORS_CACHE = { key: { pk: 'CACHE#qbo-vendors', sk: 'v0' }, field: 'vendors' }
export const QBO_ACCOUNTS_CACHE = { key: { pk: 'CACHE#qbo-accounts', sk: 'v0' }, field: 'accounts' }

export type FetchListResult<T> = { ok: true; items: T[] } | { ok: false }

interface GetCachedListParams<T> {
  ddb: DynamoDBDocumentClient
  tableName: string
  key: { pk: string; sk: string }
  field: string
  ttlMs: number
  fetchList: () => Promise<FetchListResult<T>>
  forceRefresh?: boolean
}

/**
 * Read-through DynamoDB list cache. Returns null only when the fetch failed AND there is
 * no cached copy. A failed fetch never overwrites the cache (a stale copy is served
 * instead); a successful fetch is always cached, even when the list is empty.
 */
export const getCachedList = async <T>({
  ddb,
  tableName,
  key,
  field,
  ttlMs,
  fetchList,
  forceRefresh = false,
}: GetCachedListParams<T>): Promise<{ items: T[]; refreshedAt: string } | null> => {
  const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: key }))
  // A record without a list (e.g. the stub approveVendor's invalidation upsert creates) is a miss.
  const cached = Array.isArray(Item?.[field])
    ? { items: Item[field] as T[], refreshedAt: Item.refreshedAt as string }
    : null

  if (cached && !forceRefresh && Date.now() - new Date(cached.refreshedAt).getTime() <= ttlMs) {
    return cached
  }

  const result = await fetchList()
  if (!result.ok) {
    logger.warn('QBO list fetch failed — cache preserved', {
      errorClass: 'qbo_api',
      reason: 'fetch_failed_cache_preserved',
      cacheKey: key.pk,
      cachedCount: cached?.items.length ?? 0,
    })
    return cached
  }

  const refreshedAt = new Date().toISOString()
  try {
    // A DynamoDB item is capped at 400KB (roughly 4-5k vendors); on failure serve uncached.
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: { ...key, [field]: result.items, refreshedAt },
      }),
    )
  } catch (err) {
    logger.warn('QBO list cache write failed — serving uncached', {
      cacheKey: key.pk,
      itemCount: result.items.length,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return { items: result.items, refreshedAt }
}
