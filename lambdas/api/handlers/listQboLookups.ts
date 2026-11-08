import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { respond } from '../../shared/utils/respond'
import { logger } from '../../shared/utils/logger'
import { QboVendor } from '../../shared/qbo/types'
import {
  FetchListResult,
  getCachedList,
  QBO_ACCOUNTS_CACHE,
  QBO_VENDORS_CACHE,
} from '../../shared/qbo/listCache'
import { QBO_LIST_CACHE_TTL_MS, QBO_SERVICE_URL, TABLE_NAME } from '../constants'
import { getAuthToken } from '../utils/getAuthToken'

interface LookupConfig<T> {
  cache: { key: { pk: string; sk: string }; field: string }
  path: string
  toResponse?: (items: T[]) => unknown[]
}

interface QboAccount {
  id: string
  name: string
  fullyQualifiedName: string
  accountType: string
}

const makeListHandler =
  <T>({ cache, path, toResponse = (items) => items }: LookupConfig<T>) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer, ddbClient: DynamoDBDocumentClient) => {
    let authExpired = false

    const fetchList = async (): Promise<FetchListResult<T>> => {
      try {
        const response = await fetch(`${QBO_SERVICE_URL}/${path}`, {
          headers: { Authorization: `Bearer ${await getAuthToken()}` },
        })
        if (response.ok) {
          const data = (await response.json()) as Record<string, T[]>
          if (Array.isArray(data[cache.field])) return { ok: true, items: data[cache.field] }
          logger.warn('QBO list response malformed — not cached', { path, field: cache.field })
          return { ok: false }
        }
        const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } }
        authExpired = response.status === 401 && body.error?.code === 'QBO_AUTH_EXPIRED'
        logger.warn('QBO list fetch failed', { path, status: response.status })
      } catch (err) {
        logger.warn('QBO list fetch error', { path, error: String(err) })
      }
      return { ok: false }
    }

    try {
      const cached = await getCachedList<T>({
        ddb: ddbClient,
        tableName: TABLE_NAME,
        ...cache,
        ttlMs: QBO_LIST_CACHE_TTL_MS,
        forceRefresh: event.queryStringParameters?.refresh?.toLowerCase() === 'true',
        fetchList,
      })

      if (!cached) {
        return authExpired
          ? respond(502, {
              error: 'QBO_AUTH_EXPIRED',
              message: 'QuickBooks authorization has expired. Reconnect QuickBooks.',
            })
          : respond(502, { message: `Failed to load QBO ${cache.field}` })
      }

      const items = toResponse(cached.items)
      return respond(200, {
        [cache.field]: items,
        count: items.length,
        cachedAt: cached.refreshedAt,
      })
    } catch (err) {
      logger.error(`Error listing QBO ${cache.field}`, { error: String(err) })
      return respond(500, { message: `Failed to list QBO ${cache.field}` })
    }
  }

export const listQboVendors = makeListHandler<QboVendor>({
  cache: QBO_VENDORS_CACHE,
  path: 'vendors',
  toResponse: (vendors) =>
    vendors.filter((v) => v.active !== false).map(({ id, displayName }) => ({ id, displayName })),
})

export const listQboAccounts = makeListHandler<QboAccount>({
  cache: QBO_ACCOUNTS_CACHE,
  path: 'accounts',
})
