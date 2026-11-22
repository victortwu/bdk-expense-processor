/** Environment shared by both Lambdas — the one place TABLE_NAME / QBO_SERVICE_URL are read. */
export const TABLE_NAME = process.env.TABLE_NAME!
export const QBO_SERVICE_URL = process.env.QBO_SERVICE_URL!
/** Parsely (document service) API base URL — set on the Expense API Lambda only. */
export const PARSELY_API_URL = process.env.PARSELY_API_URL!
