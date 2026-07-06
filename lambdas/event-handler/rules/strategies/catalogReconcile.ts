import { extractLineItems } from '../../utils/extractLineItems'
import {
  DocumentProcessedDetail,
  OrderGoodsProduct,
  RuleResult,
  ParsedLine,
  VendorRule,
  ConfigDefaults,
} from '../../types'
import { DEFAULT_MATCH_THRESHOLD, DEFAULT_ARITHMETIC_TOLERANCE } from '../../constants'

export const catalogReconcile = async (
  detail: DocumentProcessedDetail,
  extractedText: string,
  products: OrderGoodsProduct[],
  rule: VendorRule | null,
  config: ConfigDefaults,
): Promise<RuleResult> => {
  const matchThreshold = rule?.config.matchThreshold ?? config.matchThreshold ?? DEFAULT_MATCH_THRESHOLD
  const tolerance = config.arithmeticTolerance ?? DEFAULT_ARITHMETIC_TOLERANCE
  const categoryToAccount = rule?.config.categoryToAccount || {}
  const catchAllAccount = config.catchAllAccountRef

  // 1. Extract line items via Bedrock
  const extraction = await extractLineItems(extractedText, rule?.config.extractionPrompt)

  if (!extraction.lineItems.length) {
    return {
      status: 'needs_input',
      needsInputType: 'unmatched_items',
      validationErrors: [{ field: 'lineItems', reason: 'Could not extract any line items from receipt text' }],
    }
  }

  // 2. Match extracted items to OrderGoods products
  const parsedLines: ParsedLine[] = []
  let matchedAmount = 0
  let totalAmount = 0
  const unmatchedItems: string[] = []

  for (const item of extraction.lineItems) {
    totalAmount += item.amount

    // Try UPC match first, then description
    const matchedProduct = matchByUpc(item.upc, products) || matchByDescription(item.description, products)

    if (matchedProduct) {
      const accountRef = categoryToAccount[matchedProduct.category] || catchAllAccount
      parsedLines.push({
        amount: item.amount,
        accountRef,
        description: `${matchedProduct.category} - ${item.description}`,
      })
      matchedAmount += item.amount
    } else {
      // Unmatched → catch-all account
      parsedLines.push({
        amount: item.amount,
        accountRef: catchAllAccount,
        description: `Uncategorized - ${item.description}`,
      })
      unmatchedItems.push(item.description)
    }
  }

  // 3. Validate arithmetic (if total available from extraction)
  if (extraction.total && Math.abs(totalAmount - extraction.total) > tolerance) {
    return {
      status: 'needs_input',
      needsInputType: 'math_error',
      parsedLines,
      validationErrors: [{
        field: 'total',
        reason: `Line items sum to $${totalAmount.toFixed(2)} but receipt total is $${extraction.total.toFixed(2)}`,
        value: String(totalAmount),
      }],
    }
  }

  // 4. Check match threshold
  const matchRatio = totalAmount > 0 ? matchedAmount / totalAmount : 0

  if (matchRatio < matchThreshold && unmatchedItems.length > 0) {
    return {
      status: 'needs_input',
      needsInputType: 'unmatched_items',
      parsedLines,
      validationErrors: [{
        field: 'matchRatio',
        reason: `Only ${(matchRatio * 100).toFixed(0)}% of amount matched (threshold: ${(matchThreshold * 100).toFixed(0)}%). Unmatched: ${unmatchedItems.join(', ')}`,
        value: String(matchRatio),
      }],
    }
  }

  // 5. Ready — build QBO payload
  return {
    status: 'ready',
    parsedLines,
    qboPayload: {
      docNumber: detail.documentId.slice(0, 21),
      txnDate: detail.documentDate,
      paymentType: 'CreditCard',
      paymentAccountRef: config.paymentAccountRef,
      entityRef: { value: '', name: '' }, // filled in by caller with resolved QBO vendor
      lines: parsedLines,
      privateNote: `Auto-processed: ${detail.description || detail.vendorDisplay} [${unmatchedItems.length} unmatched items]`,
    },
  }
}

const matchByUpc = (upc: string | undefined, products: OrderGoodsProduct[]): OrderGoodsProduct | undefined => {
  if (!upc) return undefined
  return products.find((p) => p.upc === upc)
}

const matchByDescription = (description: string, products: OrderGoodsProduct[]): OrderGoodsProduct | undefined => {
  const normalized = description.toLowerCase()
  return products.find(
    (p) =>
      p.description.toLowerCase().includes(normalized) ||
      normalized.includes(p.description.toLowerCase()),
  )
}
