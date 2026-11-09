/**
 * Every DynamoDB key (and key prefix) in the expense table, built in ONE place.
 * No other module may spell a `DOC#` / `CHARGE#` / `RULE#` / `CACHE#` / `CONFIG#` literal.
 */
export interface TableKey {
  pk: string
  sk: string
}

export const DOC_PREFIX = 'DOC#'
export const RULE_PREFIX = 'RULE#'

export const docKey = (documentId: string): TableKey => ({
  pk: `${DOC_PREFIX}${documentId}`,
  sk: 'state',
})

/** Rule keys are case/whitespace-insensitive — get, put and delete all go through here. */
const normalizeVendorName = (vendorName: string): string => vendorName.toLowerCase().trim()

export const ruleKey = (vendorName: string): TableKey => ({
  pk: `${RULE_PREFIX}${normalizeVendorName(vendorName)}`,
  sk: 'v0',
})

export const configDefaultsKey = (): TableKey => ({ pk: 'CONFIG#defaults', sk: 'v0' })

export const cacheKey = (name: string): TableKey => ({ pk: `CACHE#${name}`, sk: 'v0' })

/** Primary charge identity: vendor + the vendor's own invoice number. */
export const chargeKey = (vendorId: string, invoiceNumber: string): string =>
  `CHARGE#${vendorId}#INV#${invoiceNumber}`

/** Fallback identity (review-only on match): vendor + amount + date. */
export const fallbackChargeKey = (vendorId: string, amount: number, documentDate: string): string =>
  `CHARGE#${vendorId}#AMT#${amount.toFixed(2)}#${documentDate}`

/** The one rule for which charge key a booking uses: invoice key when known, else fallback. */
export const resolveChargeKey = (p: {
  vendorId: string
  invoiceNumber?: string
  amount: number
  documentDate: string
}): string =>
  p.invoiceNumber
    ? chargeKey(p.vendorId, p.invoiceNumber)
    : fallbackChargeKey(p.vendorId, p.amount, p.documentDate)

export const markerKey = (charge: string): TableKey => ({ pk: charge, sk: 'marker' })
