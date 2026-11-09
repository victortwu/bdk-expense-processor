/**
 * In-memory DynamoDB table behind aws-sdk-client-mock: Get / Put / Update / Delete with a
 * small evaluator for the condition + update expressions this codebase emits, so tests
 * exercise REAL conditional semantics (races, status guards) instead of canned responses.
 */
import { AwsClientStub } from 'aws-sdk-client-mock'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'

type Item = Record<string, unknown>
type Names = Record<string, string>
type Values = Record<string, unknown>

const ccf = (): Error =>
  Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' })

/** Evaluate a ConditionExpression (OR / AND / NOT / parens / exists / IN / = / <) against `item`. */
export const evalCondition = (
  expr: string,
  item: Item | undefined,
  names: Names,
  values: Values,
): boolean => {
  const tokens =
    expr.match(/attribute_not_exists|attribute_exists|NOT|AND|OR|IN|[(),=<]|[#:]?[A-Za-z0-9_]+/g) ??
    []
  let i = 0
  const attr = (t: string) => item?.[names[t] ?? t]
  const operand = (t: string) => (t.startsWith(':') ? values[t] : attr(t))

  const parseOr = (): boolean => {
    let v = parseAnd()
    while (tokens[i] === 'OR') {
      i++
      const r = parseAnd()
      v = v || r
    }
    return v
  }
  const parseAnd = (): boolean => {
    let v = parseUnary()
    while (tokens[i] === 'AND') {
      i++
      const r = parseUnary()
      v = v && r
    }
    return v
  }
  const parseUnary = (): boolean => {
    const t = tokens[i++]
    if (t === 'NOT') return !parseUnary()
    if (t === '(') {
      const v = parseOr()
      i++
      return v
    }
    if (t === 'attribute_exists' || t === 'attribute_not_exists') {
      i++ // (
      const target = tokens[i++]
      i++ // )
      const present = attr(target) !== undefined
      return t === 'attribute_exists' ? present : !present
    }
    const left = operand(t)
    const op = tokens[i++]
    if (op === 'IN') {
      i++ // (
      const list: unknown[] = []
      while (tokens[i] !== ')') {
        if (tokens[i] !== ',') list.push(operand(tokens[i]))
        i++
      }
      i++
      return list.includes(left)
    }
    const right = operand(tokens[i++])
    return op === '=' ? left === right : (left as string) < (right as string)
  }
  return parseOr()
}

const applyUpdate = (item: Item, expr: string, names: Names, values: Values): Item => {
  const next = { ...item }
  const [setPart, removePart] = expr.replace(/^SET /, '').split(' REMOVE ')
  const re = /(\S+) = (?:if_not_exists\((\S+), (:\w+)\) \+ (:\w+)|(:\w+))/g
  for (const m of setPart.matchAll(re)) {
    const field = names[m[1]] ?? m[1]
    next[field] = m[2]
      ? ((item[names[m[2]] ?? m[2]] as number) ?? (values[m[3]] as number)) +
        (values[m[4]] as number)
      : values[m[5]]
  }
  for (const f of removePart?.split(', ') ?? []) delete next[names[f.trim()] ?? f.trim()]
  return next
}

export const installFakeTable = (
  ddbMock: AwsClientStub<DynamoDBDocumentClient>,
  seed: Item[] = [],
) => {
  const store = new Map<string, Item>()
  const keyOf = (k: { pk?: unknown; sk?: unknown }) => `${k.pk}|${k.sk}`
  for (const item of seed) store.set(keyOf(item), { ...item })

  const check = (
    cond: string | undefined,
    existing: Item | undefined,
    names?: Names,
    values?: Values,
  ) => {
    if (cond && !evalCondition(cond, existing, names ?? {}, values ?? {})) throw ccf()
  }

  const mock = ddbMock
  mock.on(GetCommand).callsFake(async (input) => {
    const item = store.get(keyOf(input.Key))
    return item ? { Item: { ...item } } : {}
  })
  mock.on(PutCommand).callsFake(async (input) => {
    const item = input.Item as Item
    check(
      input.ConditionExpression,
      store.get(keyOf(item)),
      input.ExpressionAttributeNames,
      input.ExpressionAttributeValues,
    )
    store.set(keyOf(item), { ...item })
    return {}
  })
  mock.on(UpdateCommand).callsFake(async (input) => {
    const existing = store.get(keyOf(input.Key))
    check(
      input.ConditionExpression,
      existing,
      input.ExpressionAttributeNames,
      input.ExpressionAttributeValues,
    )
    store.set(
      keyOf(input.Key),
      applyUpdate(
        existing ?? { ...input.Key },
        input.UpdateExpression,
        input.ExpressionAttributeNames ?? {},
        input.ExpressionAttributeValues ?? {},
      ),
    )
    return {}
  })
  mock.on(DeleteCommand).callsFake(async (input) => {
    check(
      input.ConditionExpression,
      store.get(keyOf(input.Key)),
      input.ExpressionAttributeNames,
      input.ExpressionAttributeValues,
    )
    store.delete(keyOf(input.Key))
    return {}
  })

  return {
    store,
    get: (pk: string, sk: string) => store.get(`${pk}|${sk}`),
    put: (item: Item) => store.set(keyOf(item), { ...item }),
  }
}
