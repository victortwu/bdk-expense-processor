/**
 * STAGE 3 — decideBooking DETERMINISTIC PROPERTY TESTS (pure, no AWS/LLM)
 * ────────────────────────────────────────────────────────────────────────────
 * Isolates the booking POLICY from the model: feed labeled intents, assert the
 * deterministic outcome. This is the release-gating safety net — it proves that
 * GIVEN a correct intent, the system books/skips/reviews correctly, independent
 * of Bedrock. (The LLM's accuracy at producing the intent is measured separately
 * by the real-Bedrock eval.)
 */
import {
  decideBooking,
  chargeKey,
} from '../../lambdas/event-handler/intent/decideBooking'
import { DecisionInput, FinancialIntent } from '../../lambdas/event-handler/intent/types'

const noExisting = () => undefined

const base = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  intent: 'bill',
  intentConfidence: 'high',
  vendorId: 'west-coast-pita',
  invoiceNumber: '3864339',
  referencedInvoiceNumbers: [],
  amount: 589.29,
  documentDate: '2026-08-24',
  lookupCharge: noExisting,
  confidenceFloor: 'medium',
  ...over,
})

describe('decideBooking — intent → accrual policy', () => {
  it('bill (new charge) → book', () => {
    const out = decideBooking(base())
    expect(out.action).toBe('book')
    if (out.action === 'book') expect(out.chargeKey).toBe(chargeKey('west-coast-pita', '3864339'))
  })

  it('reminder → informational (never books)', () => {
    expect(decideBooking(base({ intent: 'reminder' })).action).toBe('informational')
  })

  it('statement → informational (never books)', () => {
    expect(decideBooking(base({ intent: 'statement' })).action).toBe('informational')
  })

  it('unknown → needs_review', () => {
    expect(decideBooking(base({ intent: 'unknown' })).action).toBe('needs_review')
  })

  it('receipt without a recorded bill → needs_review (not booked)', () => {
    const out = decideBooking(base({ intent: 'receipt', invoiceNumber: undefined }))
    expect(out.action).toBe('needs_review')
    if (out.action === 'needs_review') expect(out.reason).toBe('receipt_without_recorded_bill')
  })

  it('receipt referencing an already-booked charge → informational', () => {
    const out = decideBooking(
      base({
        intent: 'receipt',
        invoiceNumber: undefined,
        referencedInvoiceNumbers: ['3864339'],
        lookupCharge: (k) =>
          k === chargeKey('west-coast-pita', '3864339') ? { qboPurchaseId: '178' } : undefined,
      }),
    )
    expect(out.action).toBe('informational')
  })
})

describe('decideBooking — safety guards', () => {
  it('low confidence below floor → needs_review (fail-safe)', () => {
    const out = decideBooking(base({ intentConfidence: 'low', confidenceFloor: 'medium' }))
    expect(out.action).toBe('needs_review')
    if (out.action === 'needs_review') expect(out.reason).toBe('low_intent_confidence')
  })

  it('bill referencing MULTIPLE invoices → needs_review (aggregate-payment guard)', () => {
    const out = decideBooking(base({ referencedInvoiceNumbers: ['3864339', '3864090'] }))
    expect(out.action).toBe('needs_review')
    if (out.action === 'needs_review') expect(out.reason).toBe('multiple_invoice_references')
  })

  it('bill with no invoice number + fallback-key match → needs_review (not auto-skip)', () => {
    const out = decideBooking(
      base({
        invoiceNumber: undefined,
        lookupCharge: () => ({ qboPurchaseId: '200' }), // some fallback-key hit
      }),
    )
    expect(out.action).toBe('needs_review')
    if (out.action === 'needs_review') expect(out.reason).toBe('possible_duplicate_fallback_key')
  })
})

describe('decideBooking — dedup (primary key)', () => {
  it('two inputs with the same charge identity → one book, one skip_duplicate', () => {
    const store = new Map<string, { qboPurchaseId: string }>()
    const lookupCharge = (k: string) => store.get(k)

    const first = decideBooking(base({ lookupCharge }))
    expect(first.action).toBe('book')
    if (first.action === 'book') store.set(first.chargeKey, { qboPurchaseId: '178' })

    const second = decideBooking(base({ lookupCharge }))
    expect(second.action).toBe('skip_duplicate')
    if (second.action === 'skip_duplicate') expect(second.existingQboPurchaseId).toBe('178')
  })
})

describe('decideBooking — chargeGroup property (exactly one books)', () => {
  it('for a charge: bill books, its reminder + receipt do not', () => {
    const intents: { intent: FinancialIntent; invoiceNumber?: string; refs?: string[] }[] = [
      { intent: 'bill', invoiceNumber: '3864339' },
      { intent: 'reminder', invoiceNumber: '3864339' },
      { intent: 'receipt', refs: ['3864339'] },
    ]

    // Simulate booking state building up as the group is processed in order.
    const store = new Map<string, { qboPurchaseId: string }>()
    const lookupCharge = (k: string) => store.get(k)

    const outcomes = intents.map((it) => {
      const out = decideBooking(
        base({
          intent: it.intent,
          invoiceNumber: it.invoiceNumber,
          referencedInvoiceNumbers: it.refs ?? [],
          lookupCharge,
        }),
      )
      if (out.action === 'book') store.set(out.chargeKey, { qboPurchaseId: 'x' })
      return out.action
    })

    const bookCount = outcomes.filter((a) => a === 'book').length
    expect(bookCount).toBe(1) // exactly one bookable event per charge
    expect(outcomes).toEqual(['book', 'informational', 'informational'])
  })
})
