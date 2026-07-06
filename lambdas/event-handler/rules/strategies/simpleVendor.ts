import { QBO_SERVICE_URL } from '../../constants'
import { DocumentProcessedDetail, RuleResult, QboRef, ConfigDefaults } from '../../types'

export const simpleVendor = async (
  detail: DocumentProcessedDetail,
  qboVendorId: string,
  config: ConfigDefaults,
): Promise<RuleResult> => {
  // Query QBO for most recent purchase with this vendor
  const lastAccountRef = await getLastExpenseAccount(qboVendorId)

  if (!lastAccountRef) {
    // First-time vendor — needs human to pick expense account
    return {
      status: 'needs_input',
      needsInputType: 'pick_expense_account',
      validationErrors: [{
        field: 'expenseAccount',
        reason: `No previous expenses found for this vendor. Please select an expense account.`,
      }],
    }
  }

  // Has history — auto-submit with same account
  const amount = detail.amounts[0] || 0

  if (amount <= 0) {
    return {
      status: 'needs_input',
      validationErrors: [{
        field: 'amounts',
        reason: 'No valid positive amount found in document',
        value: JSON.stringify(detail.amounts),
      }],
    }
  }

  const parsedLines = [{
    amount,
    accountRef: lastAccountRef,
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
      privateNote: `Auto-processed: ${detail.description || detail.vendorDisplay}`,
    },
  }
}

const getLastExpenseAccount = async (vendorId: string): Promise<QboRef | null> => {
  if (!QBO_SERVICE_URL) return null

  try {
    const response = await fetch(
      `${QBO_SERVICE_URL}/purchases?vendor=${encodeURIComponent(vendorId)}`,
    )

    if (!response.ok) return null

    const data = (await response.json()) as {
      purchases: Array<{
        lines: Array<{ accountRef: QboRef }>
      }>
    }

    const purchases = data.purchases || []
    if (purchases.length === 0) return null

    // Use the account from the most recent purchase's first line
    const lastPurchase = purchases[0]
    return lastPurchase.lines?.[0]?.accountRef || null
  } catch (err) {
    console.error('Error querying QBO purchase history:', err)
    return null
  }
}
