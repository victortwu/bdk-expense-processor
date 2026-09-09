import { COGNITO_TOKEN_URL, MACHINE_CLIENT_ID, MACHINE_CLIENT_SECRET } from '../constants'

let cachedToken: string | null = null
let tokenExpiresAt = 0

/**
 * Gets a valid machine-to-machine JWT via Cognito client-credentials grant, used
 * to authenticate this API Lambda's server-side calls to the JWT-protected QBO
 * Service (e.g. POST /purchases from the manual set-account / submit / retry
 * flows). Mirrors the event-handler's util; cached per container, refreshed 5
 * minutes before expiry.
 */
export const getAuthToken = async (): Promise<string> => {
  const now = Date.now()
  const bufferMs = 5 * 60 * 1000 // 5 minute buffer

  if (cachedToken && now < tokenExpiresAt - bufferMs) {
    return cachedToken
  }

  if (!COGNITO_TOKEN_URL || !MACHINE_CLIENT_ID || !MACHINE_CLIENT_SECRET) {
    throw new Error('Missing Cognito auth configuration (TOKEN_URL, CLIENT_ID, or CLIENT_SECRET)')
  }

  const credentials = Buffer.from(`${MACHINE_CLIENT_ID}:${MACHINE_CLIENT_SECRET}`).toString(
    'base64',
  )

  const response = await fetch(COGNITO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials&scope=parsely/read parsely/write',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token request failed (${response.status}): ${errorText}`)
  }

  const data = (await response.json()) as { access_token: string; expires_in: number }
  cachedToken = data.access_token
  tokenExpiresAt = now + data.expires_in * 1000

  return cachedToken
}
