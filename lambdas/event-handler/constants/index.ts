export const TABLE_NAME = process.env.TABLE_NAME!
export const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET!
export const QBO_SERVICE_URL = process.env.QBO_SERVICE_URL!
export const ORDERGOODS_API_URL = process.env.ORDERGOODS_API_URL || ''

export const BEDROCK_MODEL_ID = 'us.amazon.nova-lite-v1:0'
export const BEDROCK_REGION = process.env.AWS_REGION || 'us-west-2'

export const VENDOR_CACHE_TTL_HOURS = 24
export const DEFAULT_MATCH_THRESHOLD = 0.9
export const DEFAULT_ARITHMETIC_TOLERANCE = 0.05
