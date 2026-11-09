import { AwsClientStub } from 'aws-sdk-client-mock'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'

type Item = Record<string, unknown>
type Calls = Pick<AwsClientStub<DynamoDBDocumentClient>, 'commandCalls'>

/**
 * For tests whose DynamoDB mock only records calls: replay the DOC# state writes (the
 * pipeline's Put, then the repo's conditional Update transitions) into the resulting item.
 * Update placeholders are `:<field>` and REMOVE targets `#<field>` (see `buildTransition`).
 */
export const writtenState = (ddbMock: Calls): Item | undefined => {
  const puts = ddbMock
    .commandCalls(PutCommand)
    .map((c) => c.args[0].input as { Item?: Item })
    .filter((i) => i.Item?.sk === 'state')
  let state: Item | undefined = puts.length ? { ...puts[puts.length - 1].Item } : undefined

  for (const call of ddbMock.commandCalls(UpdateCommand)) {
    const input = call.args[0].input as {
      Key?: { sk?: string }
      UpdateExpression?: string
      ExpressionAttributeValues?: Item
    }
    if (input.Key?.sk !== 'state' || !state) continue
    const [setPart, removePart] = (input.UpdateExpression ?? '').split(' REMOVE ')
    for (const m of setPart.matchAll(/#(\w+) = :(\w+)/g)) {
      state[m[1]] = input.ExpressionAttributeValues?.[`:${m[2]}`]
    }
    for (const f of removePart?.split(', ') ?? []) delete state[f.replace('#', '')]
  }
  return state
}

/** The final (booked) CHARGE# marker Put, if any. */
export const writtenMarker = (ddbMock: Calls): Item | undefined =>
  ddbMock
    .commandCalls(PutCommand)
    .map((c) => (c.args[0].input as { Item?: Item }).Item)
    .filter((i): i is Item => i?.sk === 'marker' && !!i.qboPurchaseId)
    .pop()
