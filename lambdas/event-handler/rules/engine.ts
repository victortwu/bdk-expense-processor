import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import { TABLE_NAME } from '../constants'
import {
  DocumentProcessedDetail,
  RuleResult,
  VendorRule,
  ConfigDefaults,
  OrderGoodsProduct,
  QboRef,
} from '../types'
import { catalogReconcile } from './strategies/catalogReconcile'
import { amountRange } from './strategies/amountRange'
import { simpleVendor } from './strategies/simpleVendor'

const DEFAULT_CONFIG: ConfigDefaults = {
  paymentAccountRef: { value: '1', name: 'Default Credit Card' },
  catchAllAccountRef: { value: '99', name: 'Uncategorized Expense' },
  matchThreshold: 0.9,
  arithmeticTolerance: 0.05,
}

export const getConfig = async (ddb: DynamoDBDocumentClient): Promise<ConfigDefaults> => {
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'CONFIG#defaults', sk: 'v0' },
      }),
    )
    if (result.Item) {
      return { ...DEFAULT_CONFIG, ...result.Item } as ConfigDefaults
    }
  } catch (err) {
    console.error('Error fetching config defaults:', err)
  }
  return DEFAULT_CONFIG
}

export const getVendorRule = async (
  ddb: DynamoDBDocumentClient,
  vendorName: string,
): Promise<VendorRule | null> => {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `RULE#${vendorName}`, sk: 'v0' },
    }),
  )
  return (result.Item as VendorRule) || null
}

export interface ApplyRulesParams {
  detail: DocumentProcessedDetail
  extractedText: string
  isMultiLine: boolean
  products: OrderGoodsProduct[]
  qboVendorId: string
  qboVendorRef: QboRef
  rule: VendorRule | null
  config: ConfigDefaults
}

export const applyRules = async (params: ApplyRulesParams): Promise<RuleResult> => {
  const { detail, extractedText, isMultiLine, products, qboVendorId, qboVendorRef, rule, config } = params

  let result: RuleResult

  // If an explicit rule exists, use its strategy
  if (rule) {
    switch (rule.ruleType) {
      case 'catalog_reconcile':
        result = await catalogReconcile(detail, extractedText, products, rule, config)
        break
      case 'amount_range':
        result = amountRange(detail, rule.config, rule, config)
        break
      default:
        // Unknown rule type — fall through to inferred logic
        result = await inferStrategy(detail, extractedText, isMultiLine, products, qboVendorId, config)
    }
  } else {
    // No explicit rule — infer strategy from vendor classification
    result = await inferStrategy(detail, extractedText, isMultiLine, products, qboVendorId, config)
  }

  // Stamp the QBO vendor ref onto the payload if ready
  if (result.status === 'ready' && result.qboPayload) {
    result.qboPayload.entityRef = qboVendorRef
  }

  return result
}

const inferStrategy = async (
  detail: DocumentProcessedDetail,
  extractedText: string,
  isMultiLine: boolean,
  products: OrderGoodsProduct[],
  qboVendorId: string,
  config: ConfigDefaults,
): Promise<RuleResult> => {
  if (isMultiLine) {
    return catalogReconcile(detail, extractedText, products, null, config)
  }
  return simpleVendor(detail, qboVendorId, config)
}
