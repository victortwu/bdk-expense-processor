import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { ExpenseEventStack } from '../lib/stacks/expense-event-stack'
import { SQS_MAX_RETENTION_DAYS, StageConfig, stages } from '../config'
import { createStacks } from '../lib/create-stacks'

const stageByName = (name: string): StageConfig => {
  const stage = stages.find((s) => s.stageName === name)
  if (!stage) throw new Error(`Stage ${name} not found in config.ts`)
  return stage
}

const createStack = () => {
  const app = new cdk.App()
  const stack = new ExpenseEventStack(app, 'TestStack', {
    stage: stageByName('Beta'),
  })
  return Template.fromStack(stack)
}

describe('ExpenseEventStack', () => {
  let template: Template

  beforeAll(() => {
    template = createStack()
  })

  test('synthesizes without errors', () => {
    expect(template).toBeDefined()
  })

  test('creates DynamoDB table with pk/sk and KMS encryption', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      SSESpecification: {
        SSEEnabled: true,
        SSEType: 'KMS',
      },
    })
  })

  test('creates DynamoDB table with ByStatus GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        {
          IndexName: 'ByStatus',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    })
  })

  test('creates KMS key with auto-rotation', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    })
  })

  test('creates KMS key alias with correct naming', () => {
    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/datamgmt-expense-processor-beta',
    })
  })

  test('creates SQS queue with DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 300,
    })
  })

  test('creates SQS DLQ with 14-day retention', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600,
    })
  })

  test('creates EventBridge rule with correct event pattern', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['parsely.processing'],
        'detail-type': ['DocumentProcessed'],
        detail: {
          documentType: ['financial'],
        },
      },
    })
  })

  // ─── Intent Contract: what gets INTO the expense pipeline ──────────────────
  //
  // The EventBridge filter is the ENTRY GATE for the entire expense pipeline. A
  // document that does not match this pattern is silently dropped — it never
  // reaches the event-handler Lambda, and nothing downstream can recover it.
  //
  // These tests exist to make the gate an EXPLICIT, DELIBERATE contract rather
  // than an incidental filter. They encode two intents:
  //
  //   1. ONLY `documentType === 'financial'` enters the pipeline. This is
  //      deliberate: Parsely's classifier routes bills/charges/receipts/invoices
  //      for goods & services to `financial` (see the classification priority
  //      rules in the Bedrock prompt). `tax` (government obligations) and
  //      `correspondence` (non-monetary) are intentionally EXCLUDED even though
  //      they may carry dollar amounts.
  //
  //   2. The gate filters on `documentType` ONLY — NOT on `subType`. Every
  //      financial subType (invoice, receipt, notification, ...) is admitted, so
  //      the expense processor's rules engine — not this coarse gate — decides
  //      how to handle each one.
  //
  // If a future requirement means an expense-relevant document classifies as
  // something OTHER than `financial` (e.g. a reimbursable `tax` payment), these
  // tests MUST fail so the widening of the gate is a conscious, reviewed change.
  describe('entry-gate intent contract', () => {
    const getFilteredDocumentTypes = (): string[] => {
      const rules = template.findResources('AWS::Events::Rule')
      const rule = Object.values(rules).find(
        (r) => r.Properties?.EventPattern?.source?.[0] === 'parsely.processing',
      )
      return rule?.Properties?.EventPattern?.detail?.documentType ?? []
    }

    test('admits EXACTLY the "financial" documentType — nothing more, nothing less', () => {
      // A single admitted type is the whole contract: widening (adding a type) or
      // narrowing (removing financial) both break this and demand review.
      expect(getFilteredDocumentTypes()).toEqual(['financial'])
    })

    test('deliberately EXCLUDES tax and correspondence from the expense pipeline', () => {
      const admitted = getFilteredDocumentTypes()
      expect(admitted).not.toContain('tax')
      expect(admitted).not.toContain('correspondence')
      expect(admitted).not.toContain('unknown')
    })

    test('does NOT filter on subType — every financial subType is admitted', () => {
      const rules = template.findResources('AWS::Events::Rule')
      const rule = Object.values(rules).find(
        (r) => r.Properties?.EventPattern?.source?.[0] === 'parsely.processing',
      )
      // subType filtering here would silently drop e.g. financial/notification
      // receipts; the rules engine must own subType handling, not the gate.
      expect(rule?.Properties?.EventPattern?.detail?.subType).toBeUndefined()
    })
  })

  test('creates Event Handler Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'Beta-BDK-ExpenseProcessor-EventHandler',
      Timeout: 60,
    })
  })

  test('creates SQS event source mapping with batch size 1', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
    })
  })

  test('writes SSM parameter for table name', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/Beta/datamgmt-expense-processor/table-name',
    })
  })

  test('writes SSM parameter for KMS key ARN', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/Beta/datamgmt-expense-processor/kms-key-arn',
    })
  })
})

describe('ExpenseEventStack autoProcess arming switch', () => {
  const templateFor = (stageName: string) =>
    Template.fromStack(
      new ExpenseEventStack(new cdk.App(), 'TestStack', { stage: stageByName(stageName) }),
    )

  const mappingFor = (stageName: string) =>
    templateFor(stageName).findResources('AWS::Lambda::EventSourceMapping')

  const queueRetentions = (stageName: string) => {
    const queues = Object.values(templateFor(stageName).findResources('AWS::SQS::Queue'))
    const main = queues.find((q) => q.Properties.RedrivePolicy)
    const dlq = queues.find((q) => !q.Properties.RedrivePolicy)
    return {
      main: main?.Properties.MessageRetentionPeriod,
      dlq: dlq?.Properties.MessageRetentionPeriod,
    }
  }

  test('Beta stage config arms the SQS event source mapping (CFN default: enabled)', () => {
    const mappings = Object.values(mappingFor('Beta'))
    expect(mappings).toHaveLength(1)
    expect(mappings[0].Properties.Enabled).not.toBe(false)
  })

  test.each([
    [true, false],
    [false, true],
  ])('autoProcess=%s on a synthetic stage: Enabled=false is %s', (autoProcess, disabled) => {
    const stage = { ...stageByName('Beta'), autoProcess }
    const mappings = Object.values(
      Template.fromStack(
        new ExpenseEventStack(new cdk.App(), 'TestStack', { stage }),
      ).findResources('AWS::Lambda::EventSourceMapping'),
    )
    expect(mappings).toHaveLength(1)
    if (disabled) expect(mappings[0].Properties.Enabled).toBe(false)
    else expect(mappings[0].Properties.Enabled).toBeUndefined()
  })

  test('Prod config is disarmed', () => {
    const mappings = Object.values(mappingFor('Prod'))
    expect(mappings).toHaveLength(1)
    expect(mappings[0].Properties.Enabled).toBe(false)
  })

  test('Prod buffers events for 14 days; Beta keeps the SQS default', () => {
    expect(queueRetentions('Beta').main).toBeUndefined()
    expect(queueRetentions('Prod').main).toBe(SQS_MAX_RETENTION_DAYS * 24 * 3600)
  })

  test('DLQ retention is at least the main queue retention in every stage', () => {
    for (const { stageName } of stages) {
      const { main, dlq } = queueRetentions(stageName)
      expect(dlq).toBeGreaterThanOrEqual(main ?? 4 * 24 * 3600)
    }
  })

  test('rejects a queue retention beyond the SQS maximum', () => {
    const stage = { ...stageByName('Prod'), queueRetentionDays: SQS_MAX_RETENTION_DAYS + 1 }
    expect(() => new ExpenseEventStack(new cdk.App(), 'TestStack', { stage })).toThrow(
      /queueRetentionDays/,
    )
  })

  test.each([0, SQS_MAX_RETENTION_DAYS + 1])('rejects queueRetentionDays=%s', (days) => {
    const stage = { ...stageByName('Prod'), queueRetentionDays: days }
    expect(() => new ExpenseEventStack(new cdk.App(), 'TestStack', { stage })).toThrow(
      /queueRetentionDays must be between 1 and 14/,
    )
  })

  test('createStacks deploys Prod stacks to the Prod account and region', () => {
    const prod = createStacks(new cdk.App(), stages).find(
      (s) => s.event.stackName === 'Prod-BDK-ExpenseProcessorEventStack',
    )
    expect(prod).toBeDefined()
    for (const stack of [prod!.event, prod!.api]) {
      expect(stack.account).toBe('639914975031')
      expect(stack.region).toBe('us-west-2')
    }
  })
})
