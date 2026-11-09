/**
 * The ONLY writer of `DOC#{id}/state`. Every mutation is conditional on the status the
 * caller expects, so concurrent actors (SQS handler, manual submit, skip) can never
 * silently clobber one another — a lost race returns `false` instead of overwriting.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { docKey } from '../keys'
import { logger } from '../utils/logger'
import { ExpenseState } from './types'
import { ExpenseStatus } from './status'

type StateFields = { [K in keyof ExpenseState]?: ExpenseState[K] | null }

export interface TransitionSpec {
  /** Only transition when the current status is one of these (and the item exists). */
  from?: readonly ExpenseStatus[]
  /** Never transition when the current status is one of these. */
  notFrom?: readonly ExpenseStatus[]
  to: ExpenseStatus
  /** Extra fields to SET (`undefined` is ignored, `null` stores NULL). */
  set?: StateFields
  /** Fields to REMOVE. */
  remove?: readonly (keyof ExpenseState)[]
  /** Bump `attempts` (initialising it if absent). */
  countAttempt?: boolean
}

const isConditionalFailure = (err: unknown): boolean =>
  (err as { name?: string })?.name === 'ConditionalCheckFailedException'

/** Run a conditional write; `false` when the condition rejected it. */
const guarded = async (write: () => Promise<unknown>): Promise<boolean> => {
  try {
    await write()
    return true
  } catch (err) {
    if (isConditionalFailure(err)) return false
    throw err
  }
}

export const buildTransition = (spec: TransitionSpec, now: string) => {
  const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' }
  const values: Record<string, unknown> = { ':status': spec.to, ':updatedAt': now }
  const sets = ['#status = :status', '#updatedAt = :updatedAt']

  for (const [field, value] of Object.entries(spec.set ?? {})) {
    if (value === undefined) continue
    names[`#${field}`] = field
    values[`:${field}`] = value
    sets.push(`#${field} = :${field}`)
  }
  if (spec.countAttempt) {
    names['#attempts'] = 'attempts'
    values[':zero'] = 0
    values[':one'] = 1
    sets.push('#attempts = if_not_exists(#attempts, :zero) + :one')
  }

  const removes = (spec.remove ?? []).map((field) => {
    names[`#${field}`] = field
    return `#${field}`
  })

  const conditions = ['attribute_exists(pk)']
  const inList = (prefix: string, statuses: readonly ExpenseStatus[]) =>
    statuses
      .map((status, i) => {
        values[`:${prefix}${i}`] = status
        return `:${prefix}${i}`
      })
      .join(', ')
  if (spec.from?.length) conditions.push(`#status IN (${inList('from', spec.from)})`)
  if (spec.notFrom?.length) conditions.push(`NOT (#status IN (${inList('not', spec.notFrom)}))`)

  return {
    UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
    ConditionExpression: conditions.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }
}

export const expenseRepo = (ddb: DynamoDBDocumentClient, tableName: string) => ({
  get: async (documentId: string): Promise<ExpenseState | undefined> => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: tableName, Key: docKey(documentId) }),
    )
    return Item as ExpenseState | undefined
  },

  /** First write for a document. `false` when another writer created it first. */
  createIfAbsent: (state: ExpenseState): Promise<boolean> =>
    guarded(() =>
      ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: state,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      ),
    ),

  /**
   * Full replace of a pipeline-owned state (reprocess). Never overwrites a record a human
   * skipped or that already booked (B8) — `false` means it was left untouched.
   */
  replaceUnlessTerminal: async (state: ExpenseState): Promise<boolean> => {
    const written = await guarded(() =>
      ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: state,
          ConditionExpression:
            'attribute_not_exists(pk) OR NOT (#status IN (:skipped, :submitted))',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':skipped': ExpenseStatus.Skipped,
            ':submitted': ExpenseStatus.Submitted,
          },
        }),
      ),
    )
    if (!written)
      logger.info('State not overwritten (skipped or submitted)', { documentId: state.documentId })
    return written
  },

  /** Conditional status transition. `false` when the item is missing or the guard rejected it. */
  transition: (documentId: string, spec: TransitionSpec): Promise<boolean> =>
    guarded(() =>
      ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: docKey(documentId),
          ...buildTransition(spec, new Date().toISOString()),
        }),
      ),
    ),
})

export type ExpenseRepo = ReturnType<typeof expenseRepo>
