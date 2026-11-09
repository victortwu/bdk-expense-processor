export const ExpenseStatus = {
  Ready: 'ready',
  NeedsInput: 'needs_input',
  Submitted: 'submitted',
  Failed: 'failed',
  Skipped: 'skipped',
  PendingValidation: 'pending_validation',
} as const

export type ExpenseStatus = (typeof ExpenseStatus)[keyof typeof ExpenseStatus]

/** Statuses the dashboard counts (pending_validation is transient and not surfaced). */
export const STATS_STATUSES = [
  ExpenseStatus.Ready,
  ExpenseStatus.NeedsInput,
  ExpenseStatus.Submitted,
  ExpenseStatus.Failed,
  ExpenseStatus.Skipped,
] as const
