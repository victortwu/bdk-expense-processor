/** Environment read once, here, for both Lambdas (a variable a Lambda is not given stays undefined). */
export const TABLE_NAME = process.env.TABLE_NAME!
export const QBO_SERVICE_URL = process.env.QBO_SERVICE_URL!
/** Parsely (document service) API base URL — set on the Expense API Lambda only; fails fast if absent. */
export const parselyApiUrl = (): string => {
  const url = process.env.PARSELY_API_URL
  if (!url) throw new Error('PARSELY_API_URL is not configured on this Lambda')
  return url
}
