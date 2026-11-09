import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer
export type ApiResponse = { statusCode: number; headers: Record<string, string>; body: string }
export type ApiHandler = (event: ApiEvent, ddb: DynamoDBDocumentClient) => Promise<ApiResponse>

export const respond = (statusCode: number, body?: unknown): ApiResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : '',
})

/**
 * A client-visible failure. Thrown from anywhere in a request; the router turns it into
 * `{ message, ...extra }` with the given status — the single error envelope.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }

  toResponse = (): ApiResponse => respond(this.statusCode, { message: this.message, ...this.extra })
}

/** Parse the JSON request body (empty → `{}`); malformed or non-object → 400. */
export const parseJsonBody = <T = Record<string, unknown>>(event: ApiEvent): T => {
  let parsed: unknown
  try {
    parsed = JSON.parse(event.body || '{}')
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'Request body must be a JSON object')
  }
  return parsed as T
}
