export interface StageConfig {
  stageName: string
  ordergoodsApiUrl?: string
  env?: { account: string; region: string }
}

export const stages: StageConfig[] = [{ stageName: 'Beta' }]
