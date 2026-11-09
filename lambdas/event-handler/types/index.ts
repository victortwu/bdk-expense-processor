import type {
  NeedsInputType,
  ParsedLine,
  QboPayload,
  ValidationError,
} from '../../shared/expense/types'
import type { QboRef } from '../../shared/qbo/types'
import type { AmountInput } from '../../shared/utils/parseAmount'

// ─── Event Payload ─────────────────────────────────────────────────────────

export interface DocumentProcessedDetail {
  tenantId: string
  documentId: string
  documentType: string
  subType: string
  vendorName: string
  vendorDisplay: string
  documentDate: string
  amounts: AmountInput[]
  description: string
  confidence: string
  source: string
  extractedTextUri: string
  originalUri?: string
}

// ─── Rules & Config ────────────────────────────────────────────────────────

export interface VendorRule {
  pk: string
  sk: string
  ruleType: 'catalog_reconcile' | 'amount_range'
  config: RuleConfig
  defaultExpenseAccountRef?: QboRef
  qboVendorRef?: QboRef
  autoSubmit?: boolean
  /**
   * OPTIONAL per-vendor intent context injected into the Stage-2 classifyIntent
   * prompt. Describes this vendor's document lifecycle (e.g. "sends an invoice
   * then a separate autopay receipt"). INTENT context only — never booking
   * mechanics. If absent, classifyIntent runs without vendor-specific notes.
   */
  documentProfile?: string
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

export interface RuleResult {
  status: 'ready' | 'needs_input'
  parsedLines?: ParsedLine[]
  validationErrors?: ValidationError[]
  needsInputType?: NeedsInputType
  qboPayload?: QboPayload
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

// ─── Extracted Line Item (from Bedrock) ────────────────────────────────────

export interface NonFoodItem {
  description: string
  amount: number
  category: string // 'packaging' | 'janitorial' | 'delivery' | 'other'
}

export interface ExtractionResult {
  grandTotal: number
  tax?: number
  deliveryFee?: number
  nonFoodItems: NonFoodItem[]
}
