/** Table-driven tests of the conditional DOC# state transitions (real condition semantics). */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  buildTransition,
  expenseRepo,
  TransitionSpec,
} from '../../lambdas/shared/expense/expenseRepo'
import { ExpenseStatus } from '../../lambdas/shared/expense/status'
import { ExpenseState } from '../../lambdas/shared/expense/types'
import { installFakeTable } from '../helpers/fakeTable'

const ddbMock = mockClient(DynamoDBDocumentClient)
const repo = expenseRepo(DynamoDBDocumentClient.from(new DynamoDBClient({})), 'tbl')
const { Ready, NeedsInput, Submitted, Failed, Skipped } = ExpenseStatus

let table: ReturnType<typeof installFakeTable>
const seed = (status: string) =>
  table.put({ pk: 'DOC#d', sk: 'state', documentId: 'd', status, attempts: 2, failureReason: 'x' })
const current = () => table.get('DOC#d', 'state')!

const stateOf = (status: ExpenseStatus): ExpenseState => ({
  pk: 'DOC#d',
  sk: 'state',
  tenantId: 't',
  documentId: 'd',
  status,
  vendorName: 'v',
  documentDate: '',
  amounts: [],
  attempts: 0,
  createdAt: 'c',
  updatedAt: 'u',
})

beforeEach(() => {
  ddbMock.reset()
  table = installFakeTable(ddbMock)
})

describe('expenseRepo.transition', () => {
  it.each<[string, string | undefined, TransitionSpec, boolean]>([
    ['from matches', Ready, { from: [Ready, Failed], to: Submitted }, true],
    ['from does not match', Submitted, { from: [Ready, Failed], to: Submitted }, false],
    [
      'notFrom excludes submitted (skip guard, B4)',
      Submitted,
      { notFrom: [Submitted], to: Skipped },
      false,
    ],
    ['notFrom allows other statuses', NeedsInput, { notFrom: [Submitted], to: Skipped }, true],
    [
      'from AND notFrom both apply',
      Failed,
      { from: [Failed, Skipped], notFrom: [Skipped], to: Ready },
      true,
    ],
    ['missing item never transitions', undefined, { notFrom: [Submitted], to: Skipped }, false],
  ])('%s', async (_name, status, spec, expected) => {
    if (status) seed(status)

    expect(await repo.transition('d', spec)).toBe(expected)

    if (status) expect(current().status).toBe(expected ? spec.to : status)
    else expect(table.get('DOC#d', 'state')).toBeUndefined()
  })

  it.each<[string, string | undefined, TransitionSpec, boolean]>([
    ['human-owned, guarded', 'human', { unlessHumanOwned: true, to: Failed }, false],
    ['human-owned, unguarded (a human acting)', 'human', { to: Failed }, true],
    ['pipeline-owned, guarded', 'pipeline', { unlessHumanOwned: true, to: Failed }, true],
    ['unowned, guarded', undefined, { unlessHumanOwned: true, to: Failed }, true],
  ])('human hold: %s', async (_name, owner, spec, expected) => {
    table.put({
      pk: 'DOC#d',
      sk: 'state',
      documentId: 'd',
      status: NeedsInput,
      bookingOwner: owner,
    })

    expect(await repo.transition('d', spec)).toBe(expected)
    expect(current().status).toBe(expected ? 'failed' : 'needs_input')
  })

  it('sets fields (null stores NULL, undefined is ignored), removes fields and counts the attempt', async () => {
    seed(Failed)

    await repo.transition('d', {
      to: Submitted,
      set: { qboPurchaseId: 'P', needsInputType: null, qboDocNumber: undefined },
      remove: ['failureReason'],
      countAttempt: true,
    })

    expect(current()).toMatchObject({
      status: 'submitted',
      qboPurchaseId: 'P',
      needsInputType: null,
      attempts: 3,
    })
    expect(current()).not.toHaveProperty('failureReason')
    expect(current()).not.toHaveProperty('qboDocNumber')
  })
})

describe('buildTransition', () => {
  it.each([true, false])('uses every expression name and value it declares (guard=%s)', (guard) => {
    const t = buildTransition(
      {
        unlessHumanOwned: guard,
        from: [Ready],
        notFrom: [Submitted],
        to: Failed,
        remove: ['failureReason'],
      },
      'now',
    )
    const expression = `${t.UpdateExpression} ${t.ConditionExpression}`

    for (const name of Object.keys(t.ExpressionAttributeNames)) expect(expression).toContain(name)
    for (const value of Object.keys(t.ExpressionAttributeValues))
      expect(expression).toContain(value)
    expect(expression.includes('#bookingOwner')).toBe(guard)
  })
})

describe('expenseRepo writes', () => {
  it('createIfAbsent only writes once', async () => {
    expect(await repo.createIfAbsent(stateOf(Ready))).toBe(true)
    expect(await repo.createIfAbsent(stateOf(NeedsInput))).toBe(false)
    expect(current().status).toBe('ready')
  })

  it.each([
    [Skipped, false],
    [Submitted, false],
    [Failed, true],
    [NeedsInput, true],
    [Ready, true],
  ])('replaceUnlessTerminal over %s → written=%s (B8)', async (existing, written) => {
    seed(existing)

    expect(await repo.replaceUnlessTerminal(stateOf(Ready))).toBe(written)
    expect(current().status).toBe(written ? 'ready' : existing)
  })

  it.each([
    ['human', false],
    ['pipeline', true],
    [undefined, true],
  ])(
    'replaceUnlessTerminal over a needs_input item owned by %s → written=%s (human hold)',
    async (owner, written) => {
      table.put({
        pk: 'DOC#d',
        sk: 'state',
        documentId: 'd',
        status: NeedsInput,
        bookingOwner: owner,
      })

      expect(await repo.replaceUnlessTerminal(stateOf(Ready))).toBe(written)
      expect(current().status).toBe(written ? 'ready' : 'needs_input')
    },
  )

  it('replaceUnlessTerminal creates a missing record', async () => {
    expect(await repo.replaceUnlessTerminal(stateOf(Ready))).toBe(true)
  })

  it('get returns the item or undefined', async () => {
    expect(await repo.get('d')).toBeUndefined()
    seed(Ready)
    expect(await repo.get('d')).toMatchObject({ status: 'ready' })
  })
})
