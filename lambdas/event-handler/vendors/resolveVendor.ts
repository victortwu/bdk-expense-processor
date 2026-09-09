import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { TABLE_NAME, QBO_SERVICE_URL, VENDOR_CACHE_TTL_HOURS } from '../constants'
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

  // Cache miss or stale — refresh from QBO Service
  const vendors = await fetchVendorsFromQbo()

  // Write to cache
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: 'CACHE#qbo-vendors',
        sk: 'v0',
        vendors,
        refreshedAt: new Date().toISOString(),
      },
    }),
  )

  return vendors
}

const isCacheStale = (refreshedAt: string): boolean => {
  const refreshedTime = new Date(refreshedAt).getTime()
  const now = Date.now()
  const ttlMs = VENDOR_CACHE_TTL_HOURS * 60 * 60 * 1000
  return now - refreshedTime > ttlMs
}

const fetchVendorsFromQbo = async (): Promise<QboVendor[]> => {
  if (!QBO_SERVICE_URL) return []

  try {
    const token = await getAuthToken()
    const response = await fetch(`${QBO_SERVICE_URL}/vendors`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      logger.error('QBO vendor fetch failed', {
        errorClass: 'qbo_api',
        httpStatus: response.status,
        errorName: 'QboApiError',
        errorMessage: `GET /vendors returned ${response.status}`,
      })
      return []
    }
    const data = (await response.json()) as { vendors: QboVendor[] }
    return data.vendors || []
  } catch (err) {
    logger.error('QBO vendor fetch error', {
      errorClass: 'qbo_api',
      errorName: err instanceof Error ? err.name : 'Error',
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    })
    return []
  }
}
