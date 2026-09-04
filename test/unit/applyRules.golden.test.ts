/**
 * TIER-3 GOLDEN ACCURACY HARNESS — applyRules
 * ────────────────────────────────────────────────────────────────────────────
 * Replays known expense scenarios through the REAL rules engine (applyRules) and
 * diffs the output against checked-in golden expectations. This is the repeatable
 * accuracy net that replaces eyeballing the QBO sandbox: when a rule or the engine
 * changes, the exact scenarios that change (and how) surface as test diffs.
 *
 * Scope: the DETERMINISTIC paths only — amount_range and the qboVendorRef stamping
 * — so the harness is fast, free, and network-free (no Bedrock, no QBO). The
 * multi-line catalog_reconcile path (Bedrock-dependent) is covered by its own unit
 * test (catalogReconcile.test.ts) and the Tier-1 orchestration test.
 *
 * Each golden case asserts the CONTRACT the QBO submission depends on:
 *   - status (ready vs needs_input)
 *   - parsed line amount (dollar-string → number correctness)
 *   - accountRef routing (rule default vs catch-all)
 *   - qboPayload.entityRef stamped from the deterministic qboVendorRef
 */
import { applyRules, ApplyRulesParams } from '../../lambdas/event-handler/rules/engine'
import {
  DocumentProcessedDetail,
  ConfigDefaults,
  QboRef,
  VendorRule,
} from '../../lambdas/event-handler/types'

const CONFIG: ConfigDefaults = {
  paymentAccountRef: { value: '1', name: 'BDK Credit Card' },
  catchAllAccountRef: { value: '99', name: 'Uncategorized Expense' },
  matchThreshold: 0.9,
  arithmeticTolerance: 0.05,
}

const COGS: QboRef = { value: '80', name: 'Cost of Goods Sold' }

const baseDetail = (over: Partial<DocumentProcessedDetail> = {}): DocumentProcessedDetail => ({
  tenantId: 'bdk',
  documentId: '01J8XZQK3P0000000000000001',
  documentType: 'financial',
  subType: 'invoice',
  vendorName: 'franz-bakery',
  vendorDisplay: 'Franz Bakery',
  documentDate: '2026-07-25',
  // amounts is string[] per the producer contract (dollar-formatted)
  amounts: ['$475.65'] as unknown as number[],
  description: 'Delivery',
  confidence: 'high',
  source: 'upload',
  extractedTextUri: 's3://b/doc/extracted.txt',
  originalUri: 's3://b/doc/original.pdf',
  ...over,
})

const amountRangeRule = (over: Partial<VendorRule> = {}): VendorRule => ({
  pk: 'RULE#franz-bakery',
  sk: 'v0',
  ruleType: 'amount_range',
  config: { min: 1, max: 100000 },
  defaultExpenseAccountRef: COGS,
  qboVendorRef: { value: '55', name: 'Franz Bakery' },
  autoSubmit: true,
  ...over,
})

const run = (over: Partial<ApplyRulesParams>) =>
  applyRules({
    detail: baseDetail(),
    extractedText: '',
    isMultiLine: false,
    qboVendorId: '55',
    qboVendorRef: { value: '55', name: 'Franz Bakery' },
    rule: amountRangeRule(),
    config: CONFIG,
    ...over,
  })

describe('Tier-3 golden — applyRules deterministic paths', () => {
  it('amount_range in-range → ready with correct parsed line + entityRef stamped', async () => {
    // act
    const result = await run({})

    // assert — golden output for the Franz Bakery happy path
    expect(result.status).toBe('ready')
    expect(result.parsedLines).toHaveLength(1)
    expect(result.parsedLines?.[0]?.amount).toBeCloseTo(475.65, 2)
    expect(result.parsedLines?.[0]?.accountRef).toEqual(COGS)
    // caller-stamped deterministic vendor ref
    expect(result.qboPayload?.entityRef).toEqual({ value: '55', name: 'Franz Bakery' })
    expect(result.qboPayload?.paymentAccountRef).toEqual(CONFIG.paymentAccountRef)
    expect(result.qboPayload?.txnDate).toBe('2026-07-25')
  })

  it('parses "$1,234.56" (thousands separator) → 1234.56', async () => {
    // act
    const result = await run({ detail: baseDetail({ amounts: ['$1,234.56'] as unknown as number[] }) })

    // assert
    expect(result.status).toBe('ready')
    expect(result.parsedLines?.[0]?.amount).toBeCloseTo(1234.56, 2)
  })

  it('amount below rule minimum → needs_input (guards against fat-finger under-charges)', async () => {
    // act — rule requires >= $100, doc is $5
    const result = await run({
      detail: baseDetail({ amounts: ['$5.00'] as unknown as number[] }),
      rule: amountRangeRule({ config: { min: 100, max: 100000 } }),
    })

    // assert
    expect(result.status).toBe('needs_input')
    expect(result.validationErrors?.[0]?.field).toBe('amount')
  })

  it('amount above rule maximum → needs_input (guards against runaway over-charges)', async () => {
    // act — rule caps at $1000, doc is $9,999
    const result = await run({
      detail: baseDetail({ amounts: ['$9,999.00'] as unknown as number[] }),
      rule: amountRangeRule({ config: { min: 1, max: 1000 } }),
    })

    // assert
    expect(result.status).toBe('needs_input')
    expect(result.validationErrors?.[0]?.field).toBe('amount')
  })

  it('unparseable amount → needs_input (no silent $0 submission)', async () => {
    // act
    const result = await run({
      detail: baseDetail({ amounts: ['N/A'] as unknown as number[] }),
    })

    // assert — must NOT submit a $0 or NaN expense
    expect(result.status).toBe('needs_input')
    expect(result.validationErrors?.[0]?.field).toBe('amounts')
  })

  it('rule without defaultExpenseAccountRef → falls back to config catch-all account', async () => {
    // act
    const result = await run({
      rule: amountRangeRule({ defaultExpenseAccountRef: undefined }),
    })

    // assert — routes to Uncategorized rather than dropping the expense
    expect(result.status).toBe('ready')
    expect(result.parsedLines?.[0]?.accountRef).toEqual(CONFIG.catchAllAccountRef)
  })
})
