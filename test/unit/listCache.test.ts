import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { getCachedList } from '../../lambdas/shared/qbo/listCache'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const TTL_MS = 60 * 60 * 1000
const fresh = new Date(Date.now() - 1000).toISOString()
const stale = new Date(Date.now() - 2 * TTL_MS).toISOString()
const base = {
  ddb,
  tableName: 't',
  key: { pk: 'CACHE#x', sk: 'v0' },
  field: 'things',
  ttlMs: TTL_MS,
}
const fetched = { ok: true as const, items: ['new'] }

const fetchList = jest.fn()

beforeEach(() => {
  ddbMock.reset()
  fetchList.mockReset().mockResolvedValue(fetched)
})

const mockCache = (refreshedAt: string) =>
  ddbMock.on(GetCommand).resolves({ Item: { things: ['old'], refreshedAt } })

describe('getCachedList', () => {
  test('fresh hit returns cache without fetching or writing', async () => {
    mockCache(fresh)
    expect(await getCachedList({ ...base, fetchList })).toEqual({
      items: ['old'],
      refreshedAt: fresh,
    })
    expect(fetchList).not.toHaveBeenCalled()
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
  })

  test('stale cache refetches and writes under the configured field', async () => {
    mockCache(stale)
    const result = await getCachedList({ ...base, fetchList })
    expect(result?.items).toEqual(['new'])
    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item
    expect(put).toMatchObject({ pk: 'CACHE#x', sk: 'v0', things: ['new'] })
    expect(put?.refreshedAt).toBe(result?.refreshedAt)
  })

  test('cache miss fetches and caches an empty list', async () => {
    ddbMock.on(GetCommand).resolves({})
    fetchList.mockResolvedValue({ ok: true, items: [] })
    expect((await getCachedList({ ...base, fetchList }))?.items).toEqual([])
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1)
  })

  test('fetch failure preserves and serves the stale cache', async () => {
    mockCache(stale)
    fetchList.mockResolvedValue({ ok: false })
    expect(await getCachedList({ ...base, fetchList })).toEqual({
      items: ['old'],
      refreshedAt: stale,
    })
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
  })

  test('fetch failure with no cache returns null and writes nothing', async () => {
    ddbMock.on(GetCommand).resolves({})
    fetchList.mockResolvedValue({ ok: false })
    expect(await getCachedList({ ...base, fetchList })).toBeNull()
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0)
  })

  test('forceRefresh bypasses a fresh cache', async () => {
    mockCache(fresh)
    const result = await getCachedList({ ...base, fetchList, forceRefresh: true })
    expect(result?.items).toEqual(['new'])
    expect(fetchList).toHaveBeenCalledTimes(1)
  })

  test('stub record without the list field is a miss: fetch failure -> null, no throw', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { refreshedAt: stale } })
    fetchList.mockResolvedValue({ ok: false })
    expect(await getCachedList({ ...base, fetchList })).toBeNull()
  })

  test('stub record without the list field is a miss: fetch ok -> refetches and writes', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { refreshedAt: fresh } })
    expect((await getCachedList({ ...base, fetchList }))?.items).toEqual(['new'])
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1)
  })

  test('cache write failure still returns the fetched items', async () => {
    ddbMock.on(GetCommand).resolves({})
    ddbMock.on(PutCommand).rejects(new Error('Item size has exceeded the maximum allowed size'))
    expect((await getCachedList({ ...base, fetchList }))?.items).toEqual(['new'])
  })
})
