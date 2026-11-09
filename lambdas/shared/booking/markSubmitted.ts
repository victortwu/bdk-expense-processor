import { ExpenseRepo } from '../expense/expenseRepo'
import { ExpenseStatus } from '../expense/status'
import { ParsedLine, QboPayload } from '../expense/types'
import { QboRef } from '../qbo/types'
import { AmountInput } from '../utils/parseAmount'
import { SubmitChargeResult } from './submitCharge'

/** Everything that was actually booked — persisted so the state always mirrors QBO. */
export interface BookedExpense {
  vendorRef: QboRef
  vendorName: string
  vendorDisplay?: string
  documentDate: string
  invoiceNumber?: string
  chargeKey: string
  amounts: AmountInput[]
  parsedLines: ParsedLine[]
  qboPayload: QboPayload
}

/** Statuses a booking may leave: every status except an already-booked one. */
export const BOOKABLE_FROM = [
  ExpenseStatus.Ready,
  ExpenseStatus.NeedsInput,
  ExpenseStatus.Failed,
  ExpenseStatus.PendingValidation,
] as const

/**
 * THE success write for every booking path (event-handler, correct-and-submit, set-account,
 * bulk submit/retry): persists what was booked, clears review/failure fields.
 */
export const markSubmitted = (
  repo: ExpenseRepo,
  documentId: string,
  booked: BookedExpense,
  result: Pick<
    SubmitChargeResult,
    'qboPurchaseId' | 'qboDocNumber' | 'attachmentUploaded' | 'attachmentFailed'
  >,
  from: readonly ExpenseStatus[],
): Promise<boolean> => {
  const now = new Date().toISOString()
  return repo.transition(documentId, {
    from,
    to: ExpenseStatus.Submitted,
    countAttempt: true,
    set: {
      vendorName: booked.vendorName,
      vendorDisplay: booked.vendorDisplay ?? booked.vendorName,
      qboVendorRef: booked.vendorRef,
      documentDate: booked.documentDate,
      invoiceNumber: booked.invoiceNumber ?? null, // null clears a stale/cleared number
      chargeKey: booked.chargeKey,
      amounts: booked.amounts,
      parsedLines: booked.parsedLines,
      qboPayload: booked.qboPayload,
      qboDocNumber: result.qboDocNumber ?? booked.qboPayload.docNumber,
      qboPurchaseId: result.qboPurchaseId ?? '',
      attachmentUploaded: result.attachmentUploaded ?? null,
      attachmentFailed: result.attachmentFailed ?? null,
      needsInputType: null,
      validationErrors: null,
      submittedAt: now,
      lastAttempt: now,
    },
    remove: ['failureReason', 'failedAt'],
  })
}

/** The failure write; never flips an already-submitted expense (a failed REbook keeps its purchase). */
export const markFailed = (
  repo: ExpenseRepo,
  documentId: string,
  error: string | undefined,
): Promise<boolean> => {
  const now = new Date().toISOString()
  return repo.transition(documentId, {
    notFrom: [ExpenseStatus.Submitted],
    to: ExpenseStatus.Failed,
    countAttempt: true,
    set: { failedAt: now, failureReason: error || 'QBO submission failed', lastAttempt: now },
  })
}
