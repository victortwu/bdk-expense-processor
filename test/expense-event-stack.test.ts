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
