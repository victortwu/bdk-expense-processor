import { DocumentProcessedDetail, RuleConfig, RuleResult, VendorRule, ConfigDefaults } from '../../types'

const parseAmount = (raw: string | number): number => {
  if (typeof raw === 'number') return raw
  const cleaned = raw.replace(/[$,]/g, '')
  const parsed = parseFloat(cleaned)
  return isNaN(parsed) ? 0 : parsed
}

export const amountRange = (
  detail: DocumentProcessedDetail,
  ruleConfig: RuleConfig,
  vendorRule: VendorRule,
  config: ConfigDefaults,
): RuleResult => {
  const { min, max } = ruleConfig
  const rawAmount = detail.amounts[0]

  if (rawAmount === undefined || rawAmount === null) {
    return {
      status: 'needs_input',
      validationErrors: [{ field: 'amounts', reason: 'No amount found in document' }],
    }
  }

  const amount = parseAmount(rawAmount)

  if (amount === 0) {
    return {
      status: 'needs_input',
      validationErrors: [{ field: 'amounts', reason: 'Could not parse amount', value: String(rawAmount) }],
    }
  }

  if (min !== undefined && amount < min) {
    return {
      status: 'needs_input',
      validationErrors: [{
        field: 'amount',
        reason: `Amount $${amount} is below expected minimum $${min}`,
        value: String(amount),
      }],
    }
  }

  if (max !== undefined && amount > max) {
    return {
      status: 'needs_input',
      validationErrors: [{
        field: 'amount',
        reason: `Amount $${amount} exceeds expected maximum $${max}`,
        value: String(amount),
      }],
    }
  }

  const accountRef = vendorRule.defaultExpenseAccountRef || config.catchAllAccountRef
  const parsedLines = [{
    amount,
    accountRef,
    description: `${detail.vendorDisplay || detail.vendorName} - ${detail.documentDate}`,
  }]

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
      privateNote: `Auto-processed: ${detail.description || detail.vendorDisplay} (amount in range)`,
    },
  }
}
