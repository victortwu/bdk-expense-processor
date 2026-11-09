import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { ApiError, respond } from '../shared/http/respond'
import { routes } from './routes'
import { matchRoute } from './utils/matchRoute'

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { method } = event.requestContext.http
  const path = event.rawPath

  const match = matchRoute(routes, method, path)
  if (!match) {
    return respond(404, { message: `Route not found: ${method} ${path}` })
  }

  try {
    const withParams = {
      ...event,
      pathParameters: { ...event.pathParameters, ...match.params },
    }
    return await match.route.handler(withParams, ddbClient)
  } catch (err) {
    if (err instanceof ApiError) return err.toResponse()
    console.error('Unhandled error:', err)
    return respond(500, { message: 'Internal server error' })
  }
}
