import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { TABLE_NAME, QBO_SERVICE_URL, VENDOR_CACHE_TTL_HOURS } from '../constants'
import { QboVendor, VendorCacheRecord } from '../types'

const normalize = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, '')

export const resolveVendor = async (
  ddb: DynamoDBDocumentClient,
  vendorName: string,
): Promise<QboVendor | null> => {
  const vendors = await getCachedVendors(ddb)
  if (!vendors.length) return null

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
    const response = await fetch(`${QBO_SERVICE_URL}/vendors`)
    if (!response.ok) {
      console.error(`Failed to fetch QBO vendors: ${response.status}`)
      return []
    }
    const data = (await response.json()) as { vendors: QboVendor[] }
    return data.vendors || []
  } catch (err) {
    console.error('Error fetching QBO vendors:', err)
    return []
  }
}
