import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { configDefaultsKey } from '../keys'
import { QboRef } from '../qbo/types'

/** CONFIG#defaults.paymentAccountRef, or undefined when not configured. */
export const getPaymentAccountRef = async (
  ddb: DynamoDBDocumentClient,
  tableName: string,
): Promise<QboRef | undefined> => {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tableName, Key: configDefaultsKey() }),
  )
  const ref = Item?.paymentAccountRef as QboRef | undefined
  return ref?.value ? ref : undefined
}
