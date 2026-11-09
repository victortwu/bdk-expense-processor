import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  TABLE_NAME,
  QBO_SERVICE_URL,
  VENDOR_CACHE_TTL_HOURS,
  VENDOR_FETCH_MAX_ATTEMPTS,
  VENDOR_FETCH_BACKOFF_MS,
} from '../constants'
import { QboVendor } from '../../shared/qbo/types'
import { getAuthToken } from '../../shared/auth/getAuthToken'
import { logger } from '../../shared/utils/logger'
import { FetchListResult, getCachedList, QBO_VENDORS_CACHE } from '../../shared/qbo/listCache'

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '')

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
  const cached = await getCachedList<QboVendor>({
    ddb,
    tableName: TABLE_NAME,
    ...QBO_VENDORS_CACHE,
    ttlMs: VENDOR_CACHE_TTL_HOURS * 60 * 60 * 1000,
    fetchList: fetchVendorsFromQbo,
  })
  return cached?.items ?? []
}

// `ok:false` means the fetch itself failed (network / non-2xx / missing config) — distinct
// from a successful fetch that legitimately returns zero vendors. Only a successful fetch
// may be written to the cache.
const fetchVendorsFromQbo = async (): Promise<FetchListResult<QboVendor>> => {
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
        if (!Array.isArray(data.vendors)) {
          // Not transient — retrying won't fix a malformed body, and caching it as [] would poison the cache.
          logger.warn('QBO vendor fetch returned malformed body', {
            errorClass: 'qbo_api',
            reason: 'malformed_vendor_response',
            attempt,
          })
          return { ok: false }
        }
        const vendors = data.vendors
        logger.info('QBO vendor fetch succeeded', {
          operation: 'fetchVendorsFromQbo',
          outcome: 'ok',
          vendorCount: vendors.length,
          attempt,
        })
        return { ok: true, items: vendors }
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
