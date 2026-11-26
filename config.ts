/** SQS maximum message retention. The DLQ always uses this so a dead-lettered message never loses time. */
export const SQS_MAX_RETENTION_DAYS = 14

export interface StageConfig {
  stageName: string
  env?: { account: string; region: string }
  /**
   * Arming switch. When false the SQS event source mapping on the EventHandler Lambda is
   * disabled: DocumentProcessed events buffer in the queue (14-day retention) and nothing
   * is auto-booked to QBO. See docs/auto-process-switch.md.
   */
  autoProcess: boolean
  /** Main queue retention in days (max SQS_MAX_RETENTION_DAYS). Omit to keep the SQS default (4 days, Beta). */
  queueRetentionDays?: number
}

export const stages: StageConfig[] = [
  { stageName: 'Beta', autoProcess: true },
  {
    stageName: 'Prod',
    autoProcess: false,
    queueRetentionDays: SQS_MAX_RETENTION_DAYS,
    env: { account: '639914975031', region: 'us-west-2' },
  },
]
