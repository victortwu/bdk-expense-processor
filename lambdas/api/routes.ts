import { ApiHandler } from '../shared/http/respond'
import { approveVendor } from './handlers/approveVendor'
import { correctAndSubmit } from './handlers/correctAndSubmit'
import { deleteRule } from './handlers/deleteRule'
import { getExpense } from './handlers/getExpense'
import { getStats } from './handlers/getStats'
import { listExpenses } from './handlers/listExpenses'
import { listQboAccounts, listQboVendors } from './handlers/listQboLookups'
import { listRules } from './handlers/listRules'
import { putRule } from './handlers/putRule'
import { retryExpenses } from './handlers/retryExpenses'
import { setAccount } from './handlers/setAccount'
import { skipExpenses } from './handlers/skipExpenses'
import { submitExpenses } from './handlers/submitExpenses'

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path template; `{name}` matches exactly one segment and becomes a path parameter. */
  path: string
  handler: ApiHandler
}

/** The API surface. Literal paths are listed before templates so they win a tie. */
export const routes: Route[] = [
  { method: 'GET', path: '/expenses', handler: listExpenses },
  { method: 'POST', path: '/expenses/submit', handler: submitExpenses },
  { method: 'POST', path: '/expenses/retry', handler: retryExpenses },
  { method: 'POST', path: '/expenses/skip', handler: skipExpenses },
  { method: 'POST', path: '/expenses/approve-vendor', handler: approveVendor },
  { method: 'POST', path: '/expenses/set-account', handler: setAccount },
  { method: 'GET', path: '/expenses/{documentId}', handler: getExpense },
  { method: 'POST', path: '/expenses/{documentId}/correct-and-submit', handler: correctAndSubmit },
  { method: 'GET', path: '/rules', handler: listRules },
  { method: 'PUT', path: '/rules/{vendorName}', handler: putRule },
  { method: 'DELETE', path: '/rules/{vendorName}', handler: deleteRule },
  { method: 'GET', path: '/stats', handler: getStats },
  { method: 'GET', path: '/qbo/vendors', handler: listQboVendors },
  { method: 'GET', path: '/qbo/accounts', handler: listQboAccounts },
]
