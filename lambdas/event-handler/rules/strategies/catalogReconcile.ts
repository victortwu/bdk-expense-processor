import { extractLineItems } from '../../utils/extractLineItems'
import {
  DocumentProcessedDetail,
  RuleResult,
  ParsedLine,
  VendorRule,
  ConfigDefaults,
} from '../../types'
import { DEFAULT_ARITHMETIC_TOLERANCE } from '../../constants'

export const catalogReconcile = async (
  detail: DocumentProcessedDetail,
  extractedText: string,
  rule: VendorRule | null,
  config: ConfigDefaults,
): Promise<RuleResult> => {
  const tolerance = config.arithmeticTolerance ?? DEFAULT_ARITHMETIC_TOLERANCE
  const categoryToAccount = rule?.config.categoryToAccount || {}
  const foodAccount = categoryToAccount['food'] || { value: '80', name: 'COG - Food' }
  const catchAllAccount = config.catchAllAccountRef

  // 1. Extract structured data via Bedrock (subtraction-based prompt)
  const extraction = await extractLineItems(extractedText, rule?.config.extractionPrompt)

  if (!extraction.grandTotal || extraction.grandTotal <= 0) {
    return {
      status: 'needs_input',
      needsInputType: 'math_error',
      validationErrors: [{
        field: 'grandTotal',
        reason: 'Could not extract a valid grand total from the receipt',
      }],
    }
  }

  // 2. Sum non-food categories
  const categoryTotals: Record<string, number> = {}

  for (const item of extraction.nonFoodItems) {
    const category = item.category || 'uncategorized'
    categoryTotals[category] = (categoryTotals[category] || 0) + item.amount
  }

  const tax = extraction.tax || 0
  const deliveryFee = extraction.deliveryFee || 0
  const nonFoodTotal = Object.values(categoryTotals).reduce((sum, amt) => sum + amt, 0)

  // 3. Calculate Food COG as remainder
  const foodTotal = extraction.grandTotal - tax - deliveryFee - nonFoodTotal

  // 4. Sanity check — food total should be positive
  if (foodTotal < 0) {
    return {
      status: 'needs_input',
      needsInputType: 'math_error',
      parsedLines: buildLines(foodTotal, categoryTotals, tax, deliveryFee, categoryToAccount, foodAccount, catchAllAccount),
      validationErrors: [{
        field: 'foodTotal',
        reason: `Calculated food total is negative ($${foodTotal.toFixed(2)}). Non-food items ($${nonFoodTotal.toFixed(2)}) + tax ($${tax.toFixed(2)}) + delivery ($${deliveryFee.toFixed(2)}) exceed grand total ($${extraction.grandTotal.toFixed(2)}).`,
        value: String(foodTotal),
      }],
    }
  }

  // 5. Sanity check — food should be the majority (at least 40% of pre-tax total)
  const preTaxTotal = extraction.grandTotal - tax
  const foodRatio = preTaxTotal > 0 ? foodTotal / preTaxTotal : 0
  if (foodRatio < 0.4) {
    // Unusual — flag but don't block (emit notification upstream)
    console.warn(
      `Food ratio unusually low (${(foodRatio * 100).toFixed(0)}%) for ${detail.vendorDisplay}. Grand: $${extraction.grandTotal}, Food: $${foodTotal.toFixed(2)}`,
    )
  }

  // 6. Build QBO lines
  const parsedLines = buildLines(
    foodTotal,
    categoryTotals,
    tax,
    deliveryFee,
    categoryToAccount,
    foodAccount,
    catchAllAccount,
  )

  // 7. Verify our lines sum to grand total
  const linesSum = parsedLines.reduce((sum, line) => sum + line.amount, 0)
  if (Math.abs(linesSum - extraction.grandTotal) > tolerance) {
    return {
      status: 'needs_input',
      needsInputType: 'math_error',
      parsedLines,
      validationErrors: [{
        field: 'reconciliation',
        reason: `Lines sum to $${linesSum.toFixed(2)} but grand total is $${extraction.grandTotal.toFixed(2)}`,
        value: String(linesSum),
      }],
    }
  }

  return {
    status: 'ready',
    parsedLines,
    qboPayload: {
      docNumber: detail.documentId.slice(0, 21),
      txnDate: detail.documentDate,
      paymentType: 'CreditCard',
      paymentAccountRef: config.paymentAccountRef,
      entityRef: { value: '', name: '' }, // filled in by caller
      lines: parsedLines,
      privateNote: `Auto-processed: ${detail.description || detail.vendorDisplay} | Food: $${foodTotal.toFixed(2)}, Non-food: $${nonFoodTotal.toFixed(2)}, Tax: $${tax.toFixed(2)}`,
    },
  }
}

const buildLines = (
  foodTotal: number,
  categoryTotals: Record<string, number>,
  tax: number,
  deliveryFee: number,
  categoryToAccount: Record<string, { value: string; name: string }>,
  foodAccount: { value: string; name: string },
  catchAllAccount: { value: string; name: string },
): ParsedLine[] => {
  const lines: ParsedLine[] = []

  // Food COG (the remainder — always first, always the largest)
  if (foodTotal > 0) {
    lines.push({
      amount: round(foodTotal),
      accountRef: foodAccount,
      description: 'COG - Food',
    })
  }

  // Non-food categories
  for (const [category, total] of Object.entries(categoryTotals)) {
    if (total <= 0) continue
    const accountRef = categoryToAccount[category] || catchAllAccount
    lines.push({
      amount: round(total),
      accountRef,
      description: `${capitalize(category)}`,
    })
  }

  // Delivery fee
  if (deliveryFee > 0) {
    const deliveryAccount = categoryToAccount['delivery'] || { value: '83', name: 'Delivery Fee' }
    lines.push({
      amount: round(deliveryFee),
      accountRef: deliveryAccount,
      description: 'Delivery Fee',
    })
  }

  // Sales tax
  if (tax > 0) {
    const taxAccount = categoryToAccount['tax'] || { value: '84', name: 'Sales Tax' }
    lines.push({
      amount: round(tax),
      accountRef: taxAccount,
      description: 'Sales Tax',
    })
  }

  return lines
}

const round = (n: number): number => Math.round(n * 100) / 100

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
