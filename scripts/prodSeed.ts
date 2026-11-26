/**
 * Prod seed generator (BDK #23). DRY-RUN by default: prints a reviewable table, writes nothing.
 *
 *   npx ts-node scripts/prodSeed.ts --spec seed/prod-seed-spec.json --vendors vendors.json --accounts accounts.json
 *   npx ts-node scripts/prodSeed.ts ... --apply --table <Prod expense table> (run with AWS_PROFILE=datamgmt-prod)
 *
 * vendors.json / accounts.json are the saved responses of GET /qbo/vendors and GET /qbo/accounts on the
 * PROD expense API (real QBO company). Names in the spec are resolved to ids here; sandbox ids never appear.
 * --apply refuses to run while any row is unresolved and never overwrites an existing item.
 */
import { readFileSync } from 'fs'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { marshall } from '@aws-sdk/util-dynamodb'
import { configDefaultsKey, ruleKey } from '../lambdas/shared/keys'

interface Ref {
  value: string
  name: string
}
interface Spec {
  paymentAccount: string
  catchAllAccount: string
  categoryToAccount: Record<string, string>
  matchThreshold: number
  arithmeticTolerance: number
  rules: { vendorSlug: string; ruleType: string; qboVendor?: string; defaultAccount?: string }[]
}
interface Account {
  id: string
  name: string
  fullyQualifiedName?: string
}
interface Vendor {
  id: string
  displayName: string
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}
const need = (name: string): string => {
  const v = arg(name)
  if (!v) throw new Error(`Missing --${name}`)
  return v
}
const load = <T>(path: string, field: string): T[] => {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return Array.isArray(raw) ? raw : raw[field]
}
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Exact (case-insensitive) match only. Zero or several matches = unresolved, never a guess. */
const resolve = <T>(items: T[], names: (t: T) => string[], wanted: string): T | undefined => {
  const hits = items.filter((t) => names(t).some((n) => norm(n) === norm(wanted)))
  return hits.length === 1 ? hits[0] : undefined
}

const main = async () => {
  const spec: Spec = JSON.parse(readFileSync(need('spec'), 'utf8'))
  const vendors = load<Vendor>(need('vendors'), 'vendors')
  const accounts = load<Account>(need('accounts'), 'accounts')

  const account = (name: string): Ref | undefined => {
    const a = resolve(accounts, (x) => [x.name, x.fullyQualifiedName ?? ''], name)
    return a && { value: a.id, name: a.name }
  }
  const vendor = (name: string): Ref | undefined => {
    const v = resolve(vendors, (x) => [x.displayName], name)
    return v && { value: v.id, name: v.displayName }
  }

  const rows: { what: string; wanted: string; got?: Ref }[] = []
  const track = (what: string, wanted: string | undefined, got: Ref | undefined) => {
    if (wanted) rows.push({ what, wanted, got })
    return got
  }

  const paymentAccountRef = track(
    'defaults.paymentAccount',
    spec.paymentAccount,
    account(spec.paymentAccount),
  )
  const catchAllAccountRef = track(
    'defaults.catchAll',
    spec.catchAllAccount,
    account(spec.catchAllAccount),
  )
  const categoryToAccount = Object.fromEntries(
    Object.entries(spec.categoryToAccount).map(([cat, name]) => [
      cat,
      track(`defaults.category.${cat}`, name, account(name)),
    ]),
  )
  const ruleItems = spec.rules.map((r) => {
    const qboVendorRef = track(
      `rule.${r.vendorSlug}.vendor`,
      r.qboVendor,
      r.qboVendor ? vendor(r.qboVendor) : undefined,
    )
    const defaultExpenseAccountRef = track(
      `rule.${r.vendorSlug}.account`,
      r.defaultAccount,
      r.defaultAccount ? account(r.defaultAccount) : undefined,
    )
    return {
      ...ruleKey(r.vendorSlug),
      ruleType: r.ruleType,
      autoSubmit: true,
      config: {},
      ...(qboVendorRef && { qboVendorRef }),
      ...(defaultExpenseAccountRef && { defaultExpenseAccountRef }),
    }
  })
  const defaultsItem = {
    ...configDefaultsKey(),
    paymentAccountRef,
    catchAllAccountRef,
    categoryToAccount,
    matchThreshold: spec.matchThreshold,
    arithmeticTolerance: spec.arithmeticTolerance,
  }

  console.log('| Item | Wanted (name) | Resolved QBO name | Resolved QBO id |\n|---|---|---|---|')
  rows.forEach((r) =>
    console.log(
      `| ${r.what} | ${r.wanted} | ${r.got?.name ?? 'UNRESOLVED'} | ${r.got?.value ?? '-'} |`,
    ),
  )
  const unresolved = rows.filter((r) => !r.got)
  console.log(`\n${rows.length} refs, ${unresolved.length} unresolved. Rules: ${ruleItems.length}.`)

  if (!process.argv.includes('--apply')) return console.log('DRY RUN: nothing written.')
  if (unresolved.length) throw new Error('Refusing to apply: unresolved refs.')

  const ddb = new DynamoDBClient({ region: 'us-west-2' })
  for (const item of [defaultsItem, ...ruleItems]) {
    await ddb.send(
      new PutItemCommand({
        TableName: need('table'),
        Item: marshall(item, { removeUndefinedValues: true }),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    )
    console.log(`wrote ${item.pk}`)
  }
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
