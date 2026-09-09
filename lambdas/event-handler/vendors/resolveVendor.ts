import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import {
  TABLE_NAME,
  QBO_SERVICE_URL,
  VENDOR_CACHE_TTL_HOURS,
  VENDOR_FETCH_MAX_ATTEMPTS,
  VENDOR_FETCH_BACKOFF_MS,
} from '../constants'
import { QboVendor, VendorCacheRecord } from '../types'
import { getAuthToken } from '../utils/getAuthToken'
import { logger } from '../../shared/utils/logger'

const normalize = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, '')

export const resolveVendor = async (
  ddb: DynamoDBDocumentClient,
  vendorName: string,
): Promise<QboVendor | null> => {
  const vendors = await getCachedVendors(ddb)
  if (!vendors.length) {
    // No vendors available to match against. This is NOT the same as "vendor not
    // matched" — it usually means the QBO /vendors fetch failed or the cache is
    // empty (config/connectivity issue). Surface it distinctly so a QBO outage
    // during UAT doesn't masquerade as a genuine unknown-vendor miss.
    logger.warn('Vendor resolution: empty QBO vendor list', {
      errorClass: 'config',
      reason: 'no_vendors_available',
      vendorName,
    })
    return null
  }

  const normalizedInput = normalize(vendorName)

  // Exact normalized match
  const exact = vendors.find((v) => normalize(v.displayName) === normalizedInput)
  if (exact) return exact

  // Contains match (input contains vendor name or vice versa)
  const contains = vendors.find(
    (v) =>
      normalizedInput.includes(normalize(v.displayName)) ||
      normalize(v.displayName).includes(normalizedInput),
  )
  if (contains) return contains

  return null
}

const getCachedVendors = async (ddb: DynamoDBDocumentClient): Promise<QboVendor[]> => {
  // Try cache first
  const cacheResult = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: 'CACHE#qbo-vendors', sk: 'v0' },
    }),
  )

  const cache = cacheResult.Item as VendorCacheRecord | undefined

  if (cache && !isCacheStale(cache.refreshedAt)) {
    return cache.vendors
  }

  // Cache miss or stale — refresh from QBO Service.
  const fetchResult = await fetchVendorsFromQbo()

  if (!fetchResult.ok) {
    // The QBO /vendors fetch FAILED (network/5xx/etc). Do NOT write this into the
    // cache — caching an empty list here would poison every subsequent lookup in
    // the batch with a fresh-but-empty cache (a single transient 503 cascading
    // into many false "vendor not found" results). Instead, fall back to whatever
    // we already have cached (even if stale) so the deterministic data survives a
    // blip, and let the NEXT lookup retry the fetch.
    logger.warn('QBO vendor fetch failed — preserving existing cache, will retry next lookup', {
      errorClass: 'qbo_api',
      reason: 'fetch_failed_cache_preserved',
      cachedVendorCount: cache?.vendors.length ?? 0,
      cacheStale: cache ? isCacheStale(cache.refreshedAt) : true,
    })
    return cache?.vendors ?? []
  }

  // Fetch succeeded — safe to (re)write the cache, even if the list is genuinely
  // empty (a QBO account with zero vendors is a legitimate, cacheable state).
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: 'CACHE#qbo-vendors',
        sk: 'v0',
        vendors: fetchResult.vendors,
        refreshedAt: new Date().toISOString(),
      },
    }),
  )

  return fetchResult.vendors
}

const isCacheStale = (refreshedAt: string): boolean => {
  const refreshedTime = new Date(refreshedAt).getTime()
  const now = Date.now()
  const ttlMs = VENDOR_CACHE_TTL_HOURS * 60 * 60 * 1000
  return now - refreshedTime > ttlMs
}

// Result of a QBO /vendors fetch. `ok:false` means the fetch itself failed
// (network / non-2xx / missing config) — distinct from a successful fetch that
// legitimately returns zero vendors (`ok:true, vendors:[]`). Only a successful
// fetch may be written to the cache.
type VendorFetchResult =
  | { ok: true; vendors: QboVendor[] }
  | { ok: false }

const fetchVendorsFromQbo = async (): Promise<VendorFetchResult> => {
  if (!QBO_SERVICE_URL) {
    logger.error('QBO vendor fetch skipped — QBO_SERVICE_URL not configured', {
      errorClass: 'config',
      reason: 'missing_qbo_service_url',
    })
    return { ok: false }
  }

  // Retry transient failures (5xx / network) with a short backoff. The Run 1
  // failure was a cold-start integration 503 at the QBO Service API Gateway — a
  // single retry absorbs that class of blip. 4xx are NOT retried (client/auth
  // errors won't fix themselves) and are surfaced immediately.
  for (let attempt = 1; attempt <= VENDOR_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const token = await getAuthToken()
      const response = await fetch(`${QBO_SERVICE_URL}/vendors`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.ok) {
        const data = (await response.json()) as { vendors?: QboVendor[] }
        const vendors = data.vendors ?? []
        logger.info('QBO vendor fetch succeeded', {
          operation: 'fetchVendorsFromQbo',
          outcome: 'ok',
          vendorCount: vendors.length,
          attempt,
        })
        return { ok: true, vendors }
      }

      const transient = response.status >= 500
      logger.error('QBO vendor fetch failed', {
        errorClass: 'qbo_api',
        httpStatus: response.status,
        errorName: 'QboApiError',
        errorMessage: `GET /vendors returned ${response.status}`,
        attempt,
        willRetry: transient && attempt < VENDOR_FETCH_MAX_ATTEMPTS,
      })
      // Non-retryable (4xx) → fail now. Retryable (5xx) → fall through to backoff.
      if (!transient) return { ok: false }
    } catch (err) {
      logger.error('QBO vendor fetch error', {
        errorClass: 'qbo_api',
        errorName: err instanceof Error ? err.name : 'Error',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
        attempt,
        willRetry: attempt < VENDOR_FETCH_MAX_ATTEMPTS,
      })
    }

    if (attempt < VENDOR_FETCH_MAX_ATTEMPTS) {
      await sleep(VENDOR_FETCH_BACKOFF_MS * attempt)
    }
  }

  return { ok: false }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
