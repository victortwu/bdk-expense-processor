/**
 * UNIT TESTS — `bookExpense`, the single booking path.
 * Real conditional semantics via the in-memory table; only the QBO HTTP call is faked.
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import {
  bookExpense,
  BookExpenseParams,
  BookOutcome,
} from '../../lambdas/shared/booking/bookExpense'
import { BookedExpense } from '../../lambdas/shared/booking/markSubmitted'
import { SubmitChargeDeps } from '../../lambdas/shared/booking/submitCharge'
import { ExpenseStatus } from '../../lambdas/shared/expense/status'
import { installFakeTable } from '../helpers/fakeTable'

const ddbMock = mockClient(DynamoDBDocumentClient)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const DOC = 'DOC-1'
const CHARGE = 'CHARGE#55#INV#INV-1'
let table: ReturnType<typeof installFakeTable>
let posts: number

const booked: BookedExpense = {
  vendorRef: { value: '55', name: 'Franz Bakery' },
  vendorName: 'franz-bakery',
  vendorDisplay: 'Franz Bakery',
  documentDate: '2026-01-02',
  invoiceNumber: 'INV-1',
  chargeKey: CHARGE,
  amounts: ['$10.00'],
  parsedLines: [{ amount: 10, accountRef: { value: '80', name: 'COGS' }, description: 'x' }],
  qboPayload: {
    docNumber: DOC,
    txnDate: '2026-01-02',
    paymentType: 'CreditCard',
    paymentAccountRef: { value: '41', name: 'Visa' },
    entityRef: { value: '55', name: 'Franz Bakery' },
    lines: [{ amount: 10, accountRef: { value: '80', name: 'COGS' }, description: 'x' }],
    privateNote: 'n',
  },
}

/** QBO fake: `respond` decides each POST; counts them. */
const deps = (respond: () => { status: number; body: unknown }): SubmitChargeDeps => ({
  getAuthToken: async () => 't',
  qboServiceUrl: 'https://qbo.test',
  tableName: 'tbl',
  fetchImpl: (async () => {
    posts++
    const { status, body } = respond()
    return {
      ok: status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    }
  }) as unknown as typeof fetch,
})

const created = () => deps(() => ({ status: 200, body: { id: `P-${posts}`, docNumber: 'D' } }))

const params = (over: Partial<BookExpenseParams> = {}): BookExpenseParams => ({
  documentId: DOC,
  status: ExpenseStatus.Ready,
  booked,
  ...over,
})

const state = () => table.get(`DOC#${DOC}`, 'state')!

beforeEach(() => {
  posts = 0
  ddbMock.reset()
  table = installFakeTable(ddbMock, [
    {
      pk: `DOC#${DOC}`,
      sk: 'state',
      documentId: DOC,
      status: 'ready',
      attempts: 0,
      failureReason: 'old',
      failedAt: 'then',
    },
  ])
})

describe('bookExpense', () => {
  it('books once and mirrors everything booked onto the state (clearing stale failure fields)', async () => {
    const outcome = await bookExpense(params(), ddb, created())

    expect(outcome).toMatchObject({ kind: 'submitted', adopted: false })
    expect(posts).toBe(1)
    expect(state()).toMatchObject({
      status: 'submitted',
      qboPurchaseId: 'P-1',
      vendorName: 'franz-bakery',
      vendorDisplay: 'Franz Bakery',
      qboVendorRef: { value: '55', name: 'Franz Bakery' },
      documentDate: '2026-01-02',
      invoiceNumber: 'INV-1',
      chargeKey: CHARGE,
      amounts: ['$10.00'],
      attempts: 1,
      needsInputType: null,
    })
    expect(state().qboPayload).toEqual(booked.qboPayload)
    expect(state().parsedLines).toEqual(booked.parsedLines)
    expect(state()).not.toHaveProperty('failureReason')
    expect(state()).not.toHaveProperty('failedAt')
    expect(table.get(CHARGE, 'marker')).toMatchObject({ qboPurchaseId: 'P-1', documentId: DOC })
  })

  it('CONCURRENT double-book of the same charge yields exactly ONE QBO purchase', async () => {
    table.put({ pk: 'DOC#DOC-2', sk: 'state', documentId: 'DOC-2', status: 'ready', attempts: 0 })
    const d = created()

    const outcomes = await Promise.all([
      bookExpense(params(), ddb, d),
      bookExpense(params({ documentId: 'DOC-2' }), ddb, d),
      bookExpense(params(), ddb, d),
    ])

    expect(posts).toBe(1)
    const kinds = outcomes.map((o: BookOutcome) => o.kind).sort()
    expect(kinds).toEqual(['duplicate', 'duplicate', 'submitted'])
  })

  it('refuses to rebook a submitted expense (no QBO call) unless override is explicit', async () => {
    table.put({ ...state(), status: 'submitted', qboPurchaseId: 'P-OLD' })

    const refused = await bookExpense(params({ status: ExpenseStatus.Submitted }), ddb, created())

    expect(refused).toEqual({ kind: 'refused', reason: 'already_submitted' })
    expect(posts).toBe(0)
    expect(state().qboPurchaseId).toBe('P-OLD')
  })

  it('refuses a skipped expense without override', async () => {
    const refused = await bookExpense(params({ status: ExpenseStatus.Skipped }), ddb, created())
    expect(refused).toEqual({ kind: 'refused', reason: 'skipped_requires_override' })
  })

  it('override rebook of a submitted expense that QBO reports as duplicate is NOT passed off as new', async () => {
    table.put({ ...state(), status: 'submitted', qboPurchaseId: 'P-OLD' })
    table.put({ pk: CHARGE, sk: 'marker', documentId: DOC, qboPurchaseId: 'P-OLD' })

    const outcome = await bookExpense(
      params({ status: ExpenseStatus.Submitted, override: true }),
      ddb,
      deps(() => ({ status: 409, body: { existing: { id: 'P-OLD' } } })),
    )

    expect(outcome).toEqual({ kind: 'duplicate', existingPurchaseId: 'P-OLD' })
    expect(state()).toMatchObject({ status: 'submitted', qboPurchaseId: 'P-OLD', attempts: 0 })
  })

  it('409-adopt: QBO already holds the purchase → recorded against the expense, flagged adopted', async () => {
    const outcome = await bookExpense(
      params(),
      ddb,
      deps(() => ({ status: 409, body: { existing: { id: 'P-EXIST', docNumber: 'D-EX' } } })),
    )

    expect(outcome).toMatchObject({ kind: 'submitted', adopted: true })
    expect(state()).toMatchObject({
      status: 'submitted',
      qboPurchaseId: 'P-EXIST',
      qboDocNumber: 'D-EX',
    })
    expect(table.get(CHARGE, 'marker')).toMatchObject({ qboPurchaseId: 'P-EXIST' })
  })

  it('repairs its own earlier booking whose state write was lost (marker for THIS document) without re-posting', async () => {
    table.put({ ...state(), status: 'failed' })
    table.put({ pk: CHARGE, sk: 'marker', documentId: DOC, qboPurchaseId: 'P-LOST' })

    const outcome = await bookExpense(params({ status: ExpenseStatus.Failed }), ddb, created())

    expect(outcome).toMatchObject({ kind: 'submitted', adopted: true })
    expect(posts).toBe(0)
    expect(state()).toMatchObject({ status: 'submitted', qboPurchaseId: 'P-LOST' })
  })

  it("another document's marker blocks the booking as duplicate", async () => {
    table.put({ pk: CHARGE, sk: 'marker', documentId: 'OTHER', qboPurchaseId: 'P-9' })

    const outcome = await bookExpense(params(), ddb, created())

    expect(outcome).toEqual({ kind: 'duplicate', existingPurchaseId: 'P-9' })
    expect(posts).toBe(0)
    expect(state().status).toBe('ready')
  })

  it('QBO failure → state failed, reservation released so a retry can book', async () => {
    const failing = await bookExpense(
      params(),
      ddb,
      deps(() => ({ status: 500, body: 'boom' })),
    )

    expect(failing.kind).toBe('failed')
    expect(state()).toMatchObject({ status: 'failed', attempts: 1 })
    expect(table.get(CHARGE, 'marker')).toBeUndefined()

    const retry = await bookExpense(params({ status: ExpenseStatus.Failed }), ddb, created())
    expect(retry).toMatchObject({ kind: 'submitted', adopted: false })
    expect(state()).toMatchObject({ status: 'submitted', attempts: 2 })
    expect(state()).not.toHaveProperty('failureReason')
  })

  it('state skipped mid-flight: QBO is booked but the skip is not clobbered → conflict', async () => {
    const d = deps(() => {
      table.put({ ...state(), status: 'skipped' }) // a human skips while QBO is being called
      return { status: 200, body: { id: 'P-RACE' } }
    })

    const outcome = await bookExpense(params(), ddb, d)

    expect(outcome.kind).toBe('conflict')
    expect(state().status).toBe('skipped')
  })

  describe('orphaned reservations', () => {
    const staleAt = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

    it('a STALE reservation (even for another document) is taken over and booked through bookExpense', async () => {
      table.put({ pk: CHARGE, sk: 'marker', documentId: 'CRASHED', reservedAt: staleAt() })

      const outcome = await bookExpense(params(), ddb, created())

      expect(outcome).toMatchObject({ kind: 'submitted', adopted: false })
      expect(posts).toBe(1)
      expect(table.get(CHARGE, 'marker')).toMatchObject({ documentId: DOC, qboPurchaseId: 'P-1' })
    })

    it('a FRESH reservation still blocks as an in-flight duplicate (no id)', async () => {
      table.put({
        pk: CHARGE,
        sk: 'marker',
        documentId: 'OTHER',
        reservedAt: new Date().toISOString(),
      })

      const outcome = await bookExpense(params(), ddb, created())

      expect(outcome).toEqual({ kind: 'duplicate', existingPurchaseId: undefined })
      expect(posts).toBe(0)
    })

    it('finalizeMarker throwing after a successful POST still records the booking on the expense', async () => {
      ddbMock
        .on(PutCommand, { Item: { sk: 'marker', qboPurchaseId: 'P-1' } })
        .rejects(new Error('ddb down'))

      const outcome = await bookExpense(params(), ddb, created())

      expect(outcome).toMatchObject({ kind: 'submitted', adopted: false })
      expect(state()).toMatchObject({ status: 'submitted', qboPurchaseId: 'P-1' })
      // The reservation is left without an id; once stale it can be taken over again.
      expect(table.get(CHARGE, 'marker')).not.toHaveProperty('qboPurchaseId')
    })
  })

  it('a failed booking whose failure cannot be recorded (state changed) still reports failed', async () => {
    const outcome = await bookExpense(
      params(),
      ddb,
      deps(() => {
        table.put({ ...state(), status: 'submitted', qboPurchaseId: 'P-X' })
        return { status: 500, body: 'boom' }
      }),
    )

    expect(outcome.kind).toBe('failed')
    expect(state()).toMatchObject({ status: 'submitted', qboPurchaseId: 'P-X' })
  })

  it('markSubmitted defaults vendorDisplay to vendorName and clears a removed invoiceNumber', async () => {
    table.put({ ...state(), vendorDisplay: 'Stale Display', invoiceNumber: 'OLD' })

    await bookExpense(
      params({
        booked: {
          ...booked,
          vendorDisplay: undefined,
          invoiceNumber: undefined,
          chargeKey: CHARGE,
        },
      }),
      ddb,
      created(),
    )

    expect(state()).toMatchObject({ vendorDisplay: 'franz-bakery', invoiceNumber: null })
  })
})
