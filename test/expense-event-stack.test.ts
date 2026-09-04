import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { ExpenseEventStack } from '../lib/stacks/expense-event-stack'

const createStack = () => {
  const app = new cdk.App()
  const stack = new ExpenseEventStack(app, 'TestStack', {
    stage: { stageName: 'Beta' },
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
