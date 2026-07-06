export const respond = (statusCode: number, body?: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : '',
})
