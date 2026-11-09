import type { QboRef } from '../qbo/types'
import type { AmountInput } from '../utils/parseAmount'
import type { ExpenseStatus } from './status'

export interface ParsedLine {
  amount: number
  accountRef: QboRef
  description: string
}

export interface ValidationError {
  field: string
  reason: string
  value?: string
}

export type NeedsInputType =
  'new_vendor' | 'pick_expense_account' | 'unmatched_items' | 'math_error'

export interface QboPayload {
  docNumber: string
  txnDate: string
  paymentType: string
  paymentAccountRef: QboRef
  entityRef: QboRef
  lines: ParsedLine[]
  privateNote: string
}

/** The DOC#{id}/state item — the single source of truth for an expense's lifecycle. */
export interface ExpenseState {
  pk: string
  sk: string
  tenantId: string
  documentId: string
  status: ExpenseStatus
  vendorName: string
  vendorDisplay?: string
  documentDate: string
  /** As extracted: dollar strings on the wire, numbers once a human has corrected them. */
  amounts: AmountInput[]
  description?: string
  // Source PDF S3 URI (s3://…/original.pdf). Persisted by the event-handler so
  // manual booking paths can attach the same PDF (BDK #7).
  originalUri?: string
  /** Vendor's own invoice number (from the intent gate or a human correction). */
  invoiceNumber?: string
  /** The CHARGE# dedup key this expense books under — manual paths reuse it verbatim. */
  chargeKey?: string
  parsedLines?: ParsedLine[]
  /** Prebuilt QBO purchase payload, so ready/failed rows can be (re)submitted in bulk. */
  qboPayload?: QboPayload
  validationErrors?: ValidationError[]
  needsInputType?: NeedsInputType
  qboDocNumber?: string
  qboPurchaseId?: string
  qboVendorRef?: QboRef
  attachmentUploaded?: boolean
  attachmentFailed?: boolean
  submittedAt?: string
  failedAt?: string
  failureReason?: string
  lastAttempt?: string
  attempts: number
  createdAt: string
  updatedAt: string
}
