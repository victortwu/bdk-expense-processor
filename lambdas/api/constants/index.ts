export { TABLE_NAME, QBO_SERVICE_URL } from '../../shared/config'

// TTL for the QBO vendor/account lookup caches served by GET /qbo/*.
export const QBO_LIST_CACHE_TTL_MS = 60 * 60 * 1000
