import { distributeTaxProportionally } from '../../lambdas/event-handler/rules/strategies/catalogReconcile'

describe('distributeTaxProportionally', () => {
  it('distributes tax proportionally by dollar weight', () => {
    const categoryTotals = { packaging: 297.02, smallwares: 217.85 }
    const tax = 19.2

    const result = distributeTaxProportionally(categoryTotals, tax)

    // packaging is 57.7% of non-food, smallwares is 42.3%
    // packaging tax: 19.20 * 0.577 = 11.08 → packaging total = 297.02 + 11.08 = 308.10
    // smallwares tax: 19.20 * 0.423 = 8.12 → smallwares total = 217.85 + 8.12 = 225.97
    expect(result['packaging']).toBeCloseTo(308.1, 2)
    expect(result['smallwares']).toBeCloseTo(225.97, 2)

    // Sum of distributed tax should exactly equal original tax
    const totalTaxDistributed =
      result['packaging'] - 297.02 + (result['smallwares'] - 217.85)
    expect(totalTaxDistributed).toBeCloseTo(19.2, 2)
  })

  it('handles single category — all tax goes to it', () => {
    const categoryTotals = { janitorial: 50.0 }
    const tax = 5.13

    const result = distributeTaxProportionally(categoryTotals, tax)

    expect(result['janitorial']).toBe(55.13)
  })

  it('handles zero tax — returns original totals', () => {
    const categoryTotals = { packaging: 100, janitorial: 50 }
    const tax = 0

    const result = distributeTaxProportionally(categoryTotals, tax)

    expect(result['packaging']).toBe(100)
    expect(result['janitorial']).toBe(50)
  })

  it('handles empty categories — returns empty', () => {
    const categoryTotals: Record<string, number> = {}
    const tax = 10.0

    const result = distributeTaxProportionally(categoryTotals, tax)

    expect(Object.keys(result)).toHaveLength(0)
  })

  it('penny-exact: distributed tax cents always sum to total tax cents', () => {
    // Three categories that produce repeating decimals
    const categoryTotals = { packaging: 33.33, janitorial: 33.33, smallwares: 33.34 }
    const tax = 10.0

    const result = distributeTaxProportionally(categoryTotals, tax)

    // Total with tax should equal original subtotal + tax
    const totalWithTax = Object.values(result).reduce((sum, v) => sum + v, 0)
    const originalSubtotal = 33.33 + 33.33 + 33.34
    expect(totalWithTax).toBeCloseTo(originalSubtotal + tax, 2)
  })

  it('preserves categories with zero amounts', () => {
    const categoryTotals = { packaging: 100, janitorial: 0, smallwares: 50 }
    const tax = 6.0

    const result = distributeTaxProportionally(categoryTotals, tax)

    // janitorial has 0, so it gets no tax
    expect(result['janitorial']).toBe(0)
    // packaging gets 2/3 of tax (4.00), smallwares gets 1/3 (2.00)
    expect(result['packaging']).toBe(104)
    expect(result['smallwares']).toBe(52)
  })

  it('handles large tax on small non-food items', () => {
    // Edge case: tax is high relative to items (unlikely but tests math)
    const categoryTotals = { packaging: 5.0, other: 3.0 }
    const tax = 0.82

    const result = distributeTaxProportionally(categoryTotals, tax)

    // packaging: 62.5% → 0.51 tax, other: 37.5% → 0.31 tax
    const totalTaxDistributed = result['packaging'] - 5.0 + (result['other'] - 3.0)
    expect(totalTaxDistributed).toBeCloseTo(0.82, 2)
  })
})
