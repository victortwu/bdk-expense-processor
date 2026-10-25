export const TABLE_NAME = process.env.TABLE_NAME!
export const QBO_SERVICE_URL = process.env.QBO_SERVICE_URL!

// Processed bucket (DataMgmt processing stack) — source of the receipt PDF the
// manual booking paths best-effort attach to the QBO purchase (BDK #7). The API
// Lambda is granted s3:GetObject on this bucket + kms:Decrypt on the processing
// key by ExpenseApiStack.
export const PROCESSED_BUCKET = process.env.PROCESSED_BUCKET!

// Cognito client credentials (for authenticating this API Lambda's server-side
// calls to the JWT-protected QBO Service, e.g. POST /purchases).
export const COGNITO_TOKEN_URL = process.env.COGNITO_TOKEN_URL!
export const MACHINE_CLIENT_ID = process.env.MACHINE_CLIENT_ID!
export const MACHINE_CLIENT_SECRET = process.env.MACHINE_CLIENT_SECRET!
