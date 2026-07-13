// ─── Event Payload ─────────────────────────────────────────────────────────

export interface DocumentProcessedDetail {
  tenantId: string
  documentId: string
  documentType: string
  subType: string
  vendorName: string
  vendorDisplay: string
  documentDate: string
  amounts: number[]
  description: string
  confidence: string
  source: string
  extractedTextUri: string
  originalUri?: string
}

// ─── QBO Types ─────────────────────────────────────────────────────────────

export interface QboVendor {
  id: string
  displayName: string
}

export interface QboRef {
  value: string
  name: string
}

export interface QboPayload {
  docNumber: string
  txnDate: string
  paymentType: string
  paymentAccountRef: QboRef
  entityRef: QboRef
  lines: ParsedLine[]
  privateNote: string
}

// ─── Rules & Config ────────────────────────────────────────────────────────

export interface VendorRule {
  pk: string
  sk: string
  ruleType: 'catalog_reconcile' | 'amount_range'
  config: RuleConfig
  defaultExpenseAccountRef?: QboRef
  autoSubmit?: boolean
}

export interface RuleConfig {
  // catalog_reconcile
  extractionPrompt?: string
  categoryToAccount?: Record<string, QboRef>
  matchThreshold?: number

  // amount_range
  min?: number
  max?: number
}

export interface ConfigDefaults {
  paymentAccountRef: QboRef
  catchAllAccountRef: QboRef
  categoryToAccount?: Record<string, QboRef>
  matchThreshold: number
  arithmeticTolerance: number
}

// ─── Strategy Results ──────────────────────────────────────────────────────

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
  | 'new_vendor'
  | 'pick_expense_account'
  | 'unmatched_items'
  | 'math_error'

export interface RuleResult {
  status: 'ready' | 'needs_input'
  parsedLines?: ParsedLine[]
  validationErrors?: ValidationError[]
  needsInputType?: NeedsInputType
  qboPayload?: QboPayload
}

// ─── Expense State ─────────────────────────────────────────────────────────

export interface ExpenseState {
  pk: string
  sk: string
  tenantId: string
  documentId: string
  status: string
  vendorName: string
  vendorDisplay?: string
  documentDate: string
  amounts: number[]
  description?: string
  parsedLines?: ParsedLine[]
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

// ─── Notification Events ───────────────────────────────────────────────────

export type NotificationType =
  | 'new_vendor'
  | 'pick_expense_account'
  | 'unmatched_items'
  | 'submission_failed'
  | 'attachment_failed'
  | 'math_error'

export interface NotificationDetail {
  type: NotificationType
  documentId: string
  vendorName: string
  message: string
  metadata?: Record<string, unknown>
}

// ─── Vendor Cache ──────────────────────────────────────────────────────────

export interface VendorCacheRecord {
  pk: string
  sk: string
  vendors: QboVendor[]
  refreshedAt: string
}

// ─── Extracted Line Item (from Bedrock) ────────────────────────────────────

export interface NonFoodItem {
  description: string
  amount: number
  category: string  // 'packaging' | 'janitorial' | 'delivery' | 'other'
}

export interface ExtractionResult {
  grandTotal: number
  tax?: number
  deliveryFee?: number
  nonFoodItems: NonFoodItem[]
}
