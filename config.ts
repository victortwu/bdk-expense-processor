export interface StageConfig {
  stageName: string
  env?: { account: string; region: string }
}

export const stages: StageConfig[] = [{ stageName: 'Beta' }]
