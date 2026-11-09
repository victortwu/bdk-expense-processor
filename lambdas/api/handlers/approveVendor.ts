import { getAuthToken } from '../../shared/auth/getAuthToken'
import { expenseRepo } from '../../shared/expense/expenseRepo'
import { ExpenseStatus } from '../../shared/expense/status'
import { ApiHandler, parseJsonBody, respond } from '../../shared/http/respond'
import { invalidateCache, QBO_VENDORS_CACHE } from '../../shared/qbo/listCache'
import { QboVendor } from '../../shared/qbo/types'
import { QBO_SERVICE_URL, TABLE_NAME } from '../constants'

export const approveVendor: ApiHandler = async (event, ddbClient) => {
  const { documentId, vendorName } = parseJsonBody<{ documentId?: string; vendorName?: string }>(
    event,
  )

  if (!documentId || !vendorName) {
    return respond(400, { message: 'documentId and vendorName are required' })
  }

  const repo = expenseRepo(ddbClient, TABLE_NAME)
  const expense = await repo.get(documentId)
  if (!expense) {
    return respond(404, { message: 'Expense not found' })
  }

  if (expense.needsInputType !== 'new_vendor') {
    return respond(400, {
      message: `Expense is not awaiting vendor approval (current: ${expense.needsInputType})`,
    })
  }

  // Create vendor in QBO
  try {
    const createResponse = await fetch(`${QBO_SERVICE_URL}/vendors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await getAuthToken()}`,
      },
      body: JSON.stringify({ displayName: vendorName, companyName: vendorName }),
    })

    // 409 = vendor already exists in QBO → adopt it (body: { existing: { id, displayName } }).
    if (!createResponse.ok && createResponse.status !== 409) {
      const errorBody = await createResponse.text()
      return respond(502, { message: `Failed to create vendor in QBO: ${errorBody}` })
    }

    const data = (await createResponse.json()) as QboVendor & {
      existing?: Partial<QboVendor> & { active?: boolean }
    }
    const isDuplicate = createResponse.status === 409
    const newVendor = isDuplicate ? data.existing : data
    if (!newVendor || typeof newVendor.id !== 'string' || !newVendor.id) {
      return respond(502, {
        message: 'Failed to create vendor in QBO: malformed duplicate response',
      })
    }
    if (isDuplicate && data.existing?.active === false) {
      return respond(502, {
        message: `Vendor "${vendorName}" exists in QBO but is inactive. Reactivate it in QBO, then retry.`,
      })
    }

    // The stored ref + display name are what the event-handler re-reads on reprocess.
    const vendorRef = { value: newVendor.id, name: newVendor.displayName ?? vendorName }
    const updated = await repo.transition(documentId, {
      notFrom: [ExpenseStatus.Submitted, ExpenseStatus.Skipped],
      to: ExpenseStatus.PendingValidation,
      set: {
        qboVendorRef: vendorRef,
        vendorDisplay: vendorRef.name,
        needsInputType: null,
        validationErrors: null,
      },
    })
    if (!updated) {
      return respond(409, {
        message: 'Expense changed while approving the vendor — reload and retry',
      })
    }

    // Invalidate vendor cache so the next lookup sees the new vendor
    await invalidateCache(ddbClient, TABLE_NAME, QBO_VENDORS_CACHE)

    return respond(200, {
      message: isDuplicate
        ? `Vendor "${vendorRef.name}" already exists in QBO and was linked. The expense stays pending validation until it is re-processed.`
        : 'Vendor created in QBO. The expense stays pending validation until it is re-processed.',
      vendor: newVendor,
    })
  } catch (err) {
    console.error('Error creating vendor:', err)
    return respond(500, { message: 'Failed to create vendor' })
  }
}
