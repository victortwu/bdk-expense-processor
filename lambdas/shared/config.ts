/** Environment read once, here, for both Lambdas (a variable a Lambda is not given stays undefined). */
export const TABLE_NAME = process.env.TABLE_NAME!
export const QBO_SERVICE_URL = process.env.QBO_SERVICE_URL!
/** Parsely (document service) API base URL — set on the Expense API Lambda only. */
export const PARSELY_API_URL = process.env.PARSELY_API_URL!
