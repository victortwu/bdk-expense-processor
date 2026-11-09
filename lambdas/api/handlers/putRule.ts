import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { ApiHandler, parseJsonBody, respond } from '../../shared/http/respond'
import { ruleKey } from '../../shared/keys'
import { QboRef } from '../../shared/qbo/types'
import { VendorRule } from '../../event-handler/types'
import { TABLE_NAME } from '../constants'

type PutRuleBody = Partial<
  Pick<
    VendorRule,
    'ruleType' | 'config' | 'qboVendorRef' | 'autoSubmit' | 'defaultExpenseAccountRef'
  >
> & {
  qboPaymentType?: string
  qboPaymentAccountRef?: QboRef
  createdAt?: string
}

export const putRule: ApiHandler = async (event, ddbClient) => {
  const vendorName = event.pathParameters?.vendorName

  if (!vendorName) {
    return respond(400, { message: 'vendorName path parameter is required' })
  }

  const body = parseJsonBody<PutRuleBody>(event)

  if (!body.ruleType) {
    return respond(400, { message: 'ruleType is required' })
  }

  if (!body.qboVendorRef || !body.qboVendorRef.value || !body.qboVendorRef.name) {
    return respond(400, { message: 'qboVendorRef with value and name is required' })
  }

  const now = new Date().toISOString()

  try {
    const item = {
      ...ruleKey(vendorName),
      vendorName,
      ruleType: body.ruleType,
      config: body.config || {},
      qboVendorRef: body.qboVendorRef,
      qboPaymentType: body.qboPaymentType,
      qboPaymentAccountRef: body.qboPaymentAccountRef,
      defaultExpenseAccountRef: body.defaultExpenseAccountRef,
      autoSubmit: body.autoSubmit,
      updatedAt: now,
      createdAt: body.createdAt || now,
    }

    await ddbClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      }),
    )

    return respond(200, item)
  } catch (err) {
    console.error('Error putting rule:', err)
    return respond(500, { message: 'Failed to save rule' })
  }
}
