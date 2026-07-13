/**
 * Multi-line vendors — vendors whose receipts contain mixed food/non-food items
 * that require subtraction-based categorization (catalogReconcile strategy).
 *
 * These map to OrderGoods vendorIDs. The list rarely changes — when it does,
 * redeploy. Future v2: replace with a purpose-built OrderGoods endpoint.
 */
const MULTI_LINE_VENDORS = ['restaurant depot', 'us foods']

export interface VendorClassification {
  isMultiLine: boolean
}

export const classifyVendor = (vendorName: string): VendorClassification => {
  const normalized = vendorName.toLowerCase().trim()
  const isMultiLine = MULTI_LINE_VENDORS.some((v) => normalized.includes(v))
  return { isMultiLine }
}
