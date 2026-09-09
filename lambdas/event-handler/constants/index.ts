export const TABLE_NAME = process.env.TABLE_NAME!
export const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET!
export const QBO_SERVICE_URL = process.env.QBO_SERVICE_URL!

// Cognito client credentials (for authenticating to QBO Service)
export const COGNITO_TOKEN_URL = process.env.COGNITO_TOKEN_URL!
export const MACHINE_CLIENT_ID = process.env.MACHINE_CLIENT_ID!
export const MACHINE_CLIENT_SECRET = process.env.MACHINE_CLIENT_SECRET!

export const BEDROCK_MODEL_ID = 'us.amazon.nova-lite-v1:0'
export const BEDROCK_REGION = process.env.AWS_REGION || 'us-west-2'

export const VENDOR_CACHE_TTL_HOURS = 24
// QBO /vendors fetch resilience: absorb transient cold-start 5xx blips (Run 1 503)
// without poisoning the batch. 4xx are not retried.
export const VENDOR_FETCH_MAX_ATTEMPTS = 3
export const VENDOR_FETCH_BACKOFF_MS = 250
export const DEFAULT_MATCH_THRESHOLD = 0.9
export const DEFAULT_ARITHMETIC_TOLERANCE = 0.05

// ─── Category-to-QBO-Account Fallback ──────────────────────────────────────
// Used only if CONFIG#defaults in DynamoDB has no categoryToAccount field.
// Real account IDs are stage-specific — seed DynamoDB per environment.
export const FALLBACK_CATEGORY_TO_ACCOUNT: Record<string, { value: string; name: string }> = {
  food: { value: '80', name: 'Cost of Goods Sold' },
  packaging: { value: '80', name: 'Cost of Goods Sold' },
  janitorial: { value: '80', name: 'Cost of Goods Sold' },
  smallwares: { value: '80', name: 'Cost of Goods Sold' },
  delivery: { value: '80', name: 'Cost of Goods Sold' },
  other: { value: '80', name: 'Cost of Goods Sold' },
}
