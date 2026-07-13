import { extractLineItems } from '../../utils/extractLineItems'
import {
  DocumentProcessedDetail,
  RuleResult,
  ParsedLine,
  VendorRule,
  ConfigDefaults,
} from '../../types'
import { DEFAULT_ARITHMETIC_TOLERANCE, FALLBACK_CATEGORY_TO_ACCOUNT } from '../../constants'

export const catalogReconcile = async (
  detail: DocumentProcessedDetail,
  extractedText: string,
  rule: VendorRule | null,
  config: ConfigDefaults,
): Promise<RuleResult> => {
  const tolerance = config.arithmeticTolerance ?? DEFAULT_ARITHMETIC_TOLERANCE

  // Priority: vendor rule override > config table > hardcoded fallback
  const categoryToAccount =
    rule?.config.categoryToAccount || config.categoryToAccount || FALLBACK_CATEGORY_TO_ACCOUNT
  const foodAccount = categoryToAccount['food'] || FALLBACK_CATEGORY_TO_ACCOUNT['food']
  const catchAllAccount = categoryToAccount['other'] || config.catchAllAccountRef

  // 1. Extract structured data via Bedrock (subtraction-based prompt)
  const extraction = await extractLineItems(extractedText, rule?.config.extractionPrompt)

  if (!extraction.grandTotal || extraction.grandTotal <= 0) {
    return {
      status: 'needs_input',
      needsInputType: 'math_error',
      validationErrors: [
        {
          field: 'grandTotal',
          reason: 'Could not extract a valid grand total from the receipt',
        },
      ],
    }
  }

  // 2. Sum non-food categories
  const categoryTotals: Record<string, number> = {}

  for (const item of extraction.nonFoodItems) {
    const category = item.category || 'other'
    categoryTotals[category] = (categoryTotals[category] || 0) + item.amount
  }

  const tax = extraction.tax || 0
  const deliveryFee = extraction.deliveryFee || 0
  const nonFoodTotal = Object.values(categoryTotals).reduce((sum, amt) => sum + amt, 0)

  // 3. Distribute tax proportionally across non-food categories
  //    WA state: food is tax-exempt, so all sales tax comes from taxable non-food items.
  //    Each non-food category absorbs tax proportional to its dollar weight.
  const categoryTotalsWithTax = distributeTaxProportionally(categoryTotals, tax)
  const nonFoodWithTaxTotal = Object.values(categoryTotalsWithTax).reduce(
    (sum, amt) => sum + amt,
    0,
  )

  // 4. Calculate Food COG as remainder (grandTotal - delivery - nonFoodWithTax)
  const foodTotal = extraction.grandTotal - deliveryFee - nonFoodWithTaxTotal

  // 5. Sanity check — food total should be positive
  if (foodTotal < 0) {
    return {
      status: 'needs_input',
      needsInputType: 'math_error',
      parsedLines: buildLines(
        foodTotal,
        categoryTotalsWithTax,
        deliveryFee,
        categoryToAccount,
        foodAccount,
        catchAllAccount,
      ),
      validationErrors: [
        {
          field: 'foodTotal',
          reason: `Calculated food total is negative ($${foodTotal.toFixed(2)}). Non-food items with tax ($${nonFoodWithTaxTotal.toFixed(2)}) + delivery ($${deliveryFee.toFixed(2)}) exceed grand total ($${extraction.grandTotal.toFixed(2)}).`,
          value: String(foodTotal),
        },
      ],
    }
  }

  // 6. Sanity check — food should be the majority (at least 40% of grand total)
  const foodRatio = extraction.grandTotal > 0 ? foodTotal / extraction.grandTotal : 0
  if (foodRatio < 0.4) {
    console.warn(
      `Food ratio unusually low (${(foodRatio * 100).toFixed(0)}%) for ${detail.vendorDisplay}. Grand: $${extraction.grandTotal}, Food: $${foodTotal.toFixed(2)}`,
    )
  }

  // 7. Build QBO lines (no separate tax line — tax is absorbed into non-food categories)
  const parsedLines = buildLines(
    foodTotal,
    categoryTotalsWithTax,
    deliveryFee,
    categoryToAccount,
    foodAccount,
    catchAllAccount,
  )

  // 8. Verify our lines sum to grand total
  const linesSum = parsedLines.reduce((sum, line) => sum + line.amount, 0)
  if (Math.abs(linesSum - extraction.grandTotal) > tolerance) {
    return {
      status: 'needs_input',
      needsInputType: 'math_error',
      parsedLines,
      validationErrors: [
        {
          field: 'reconciliation',
          reason: `Lines sum to $${linesSum.toFixed(2)} but grand total is $${extraction.grandTotal.toFixed(2)}`,
          value: String(linesSum),
        },
      ],
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
      privateNote: `Auto-processed: ${detail.description || detail.vendorDisplay} | Food: $${foodTotal.toFixed(2)}, Non-food: $${nonFoodTotal.toFixed(2)}, Tax: $${tax.toFixed(2)} (distributed)`,
    },
  }
}

/**
 * Distributes sales tax proportionally across non-food categories by dollar weight.
 * WA state: food is tax-exempt, so all sales tax comes from taxable non-food items.
 *
 * Example: tax=$19.20, packaging=$297.02 (57.7%), smallwares=$217.85 (42.3%)
 * → packaging gets $11.08 tax, smallwares gets $8.12 tax
 *
 * Rounding: uses largest-remainder method to ensure distributed cents sum exactly to tax.
 */
export const distributeTaxProportionally = (
  categoryTotals: Record<string, number>,
  tax: number,
): Record<string, number> => {
  const categories = Object.entries(categoryTotals).filter(([, total]) => total > 0)
  const nonFoodSubtotal = categories.reduce((sum, [, total]) => sum + total, 0)

  // No tax or no taxable categories — return original totals
  if (tax <= 0 || nonFoodSubtotal <= 0 || categories.length === 0) {
    return { ...categoryTotals }
  }

  // Calculate proportional tax per category (in cents for precision)
  const taxCents = Math.round(tax * 100)
  const shares = categories.map(([category, total]) => {
    const exactShare = (total / nonFoodSubtotal) * taxCents
    return { category, total, floor: Math.floor(exactShare), remainder: exactShare % 1 }
  })

  // Largest-remainder method: distribute leftover cents to categories with highest remainders
  const distributedCents = shares.reduce((sum, s) => sum + s.floor, 0)
  let leftover = taxCents - distributedCents
  shares.sort((a, b) => b.remainder - a.remainder)
  for (const share of shares) {
    if (leftover <= 0) break
    share.floor += 1
    leftover -= 1
  }

  // Build result: category total + its proportional tax
  const result: Record<string, number> = {}
  for (const share of shares) {
    result[share.category] = round(share.total + share.floor / 100)
  }

  // Carry over any categories with zero amounts (shouldn't have tax)
  for (const [category, total] of Object.entries(categoryTotals)) {
    if (!(category in result)) {
      result[category] = total
    }
  }

  return result
}

const buildLines = (
  foodTotal: number,
  categoryTotalsWithTax: Record<string, number>,
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
      description: foodAccount.name,
    })
  }

  // Non-food categories (each includes proportional tax)
  for (const [category, total] of Object.entries(categoryTotalsWithTax)) {
    if (total <= 0) continue
    const accountRef = categoryToAccount[category] || catchAllAccount
    lines.push({
      amount: round(total),
      accountRef,
      description: accountRef.name,
    })
  }

  // Delivery fee
  if (deliveryFee > 0) {
    const deliveryAccount = categoryToAccount['delivery'] || catchAllAccount
    lines.push({
      amount: round(deliveryFee),
      accountRef: deliveryAccount,
      description: deliveryAccount.name,
    })
  }

  return lines
}

const round = (n: number): number => Math.round(n * 100) / 100
