import { DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { ApiHandler, respond } from '../../shared/http/respond'
import { RULE_PREFIX, ruleKey, TableKey } from '../../shared/keys'
import { TABLE_NAME } from '../constants'

export const deleteRule: ApiHandler = async (event, ddbClient) => {
  const vendorName = event.pathParameters?.vendorName

  if (!vendorName) {
    return respond(400, { message: 'vendorName path parameter is required' })
  }

  // Rules written before key normalization sit under the raw (possibly mixed-case) name;
  // try the normalized key first, then that legacy key, so they stay deletable.
  const normalized = ruleKey(vendorName)
  const legacy = { pk: `${RULE_PREFIX}${vendorName}`, sk: normalized.sk }

  const deleteIfExists = async (Key: TableKey): Promise<boolean> => {
    try {
      await ddbClient.send(
        new DeleteCommand({
          TableName: TABLE_NAME,
          Key,
          ConditionExpression: 'attribute_exists(pk)',
        }),
      )
      return true
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false
      throw err
    }
  }

  try {
    const deleted =
      (await deleteIfExists(normalized)) ||
      (legacy.pk !== normalized.pk && (await deleteIfExists(legacy)))
    return deleted
      ? respond(200, { message: `Rule deleted: ${vendorName}` })
      : respond(404, { message: `Rule not found: ${vendorName}` })
  } catch (err: unknown) {
    console.error('Error deleting rule:', err)
    return respond(500, { message: 'Failed to delete rule' })
  }
}
