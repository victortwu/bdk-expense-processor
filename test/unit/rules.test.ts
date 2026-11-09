/** RULE# key normalization is consistent across get / put / delete / list. */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'

process.env.TABLE_NAME = 'test-expense-table'

import { deleteRule } from '../../lambdas/api/handlers/deleteRule'
import { putRule } from '../../lambdas/api/handlers/putRule'
import { getVendorRule } from '../../lambdas/event-handler/rules/engine'
import { ruleKey } from '../../lambdas/shared/keys'
import { installFakeTable } from '../helpers/fakeTable'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const event = (vendorName: string, body?: unknown) =>
  ({
    pathParameters: { vendorName },
    body: JSON.stringify(body ?? {}),
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer

const ruleBody = { ruleType: 'amount_range', qboVendorRef: { value: '55', name: 'Franz Bakery' } }

let table: ReturnType<typeof installFakeTable>
beforeEach(() => {
  ddbMock.reset()
  ddbMock.on(ScanCommand).resolves({ Items: [] })
  table = installFakeTable(ddbMock)
})

describe('ruleKey', () => {
  it.each(['Franz Bakery', ' franz bakery ', 'FRANZ BAKERY'])('%j → one canonical key', (name) => {
    expect(ruleKey(name)).toEqual({ pk: 'RULE#franz bakery', sk: 'v0' })
  })
})

describe('rules round-trip', () => {
  it('a rule saved with display casing is found by the pipeline lookup and deletable under any casing', async () => {
    const put = await putRule(event('Franz Bakery', ruleBody), ddb)
    expect(put.statusCode).toBe(200)
    expect(table.get('RULE#franz bakery', 'v0')).toMatchObject({ vendorName: 'Franz Bakery' })

    expect(await getVendorRule(ddb, 'franz bakery')).toMatchObject({ vendorName: 'Franz Bakery' })

    const del = await deleteRule(event('FRANZ BAKERY'), ddb)
    expect(del.statusCode).toBe(200)
    expect(table.get('RULE#franz bakery', 'v0')).toBeUndefined()
    expect((await deleteRule(event('Franz Bakery'), ddb)).statusCode).toBe(404)
  })

  it('putting the same vendor under different casing overwrites instead of duplicating', async () => {
    await putRule(event('Franz Bakery', ruleBody), ddb)
    await putRule(event('FRANZ BAKERY', ruleBody), ddb)
    expect([...table.store.keys()].filter((k) => k.startsWith('RULE#'))).toHaveLength(1)
  })
})
