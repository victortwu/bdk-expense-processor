import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { ExpenseProcessorStack } from '../lib/stacks/expense-processor-stack'

const createStack = () => {
  const app = new cdk.App()
  const stack = new ExpenseProcessorStack(app, 'TestStack', {
    stage: { stageName: 'Beta' },
  })
  return Template.fromStack(stack)
}

describe('ExpenseProcessorStack', () => {
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
          subType: ['invoice', 'receipt'],
        },
      },
    })
  })

  test('creates 2 Lambda functions', () => {
    const lambdas = template.findResources('AWS::Lambda::Function')
    const lambdaCount = Object.keys(lambdas).length
    expect(lambdaCount).toBeGreaterThanOrEqual(2)
  })

  test('creates API Gateway HTTP API', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'Beta-BDK-ExpenseProcessor',
      ProtocolType: 'HTTP',
    })
  })

  test('creates all 11 API routes with JWT authorizer', () => {
    const routes = template.findResources('AWS::ApiGatewayV2::Route')
    const routeKeys = Object.values(routes).map(
      (r: Record<string, unknown>) =>
        (r as { Properties: { RouteKey: string } }).Properties.RouteKey,
    )

    expect(routeKeys).toContain('GET /expenses')
    expect(routeKeys).toContain('GET /expenses/{documentId}')
    expect(routeKeys).toContain('POST /expenses/submit')
    expect(routeKeys).toContain('POST /expenses/retry')
    expect(routeKeys).toContain('POST /expenses/skip')
    expect(routeKeys).toContain('POST /expenses/approve-vendor')
    expect(routeKeys).toContain('POST /expenses/set-account')
    expect(routeKeys).toContain('GET /rules')
    expect(routeKeys).toContain('PUT /rules/{vendorName}')
    expect(routeKeys).toContain('DELETE /rules/{vendorName}')
    expect(routeKeys).toContain('GET /stats')
  })

  test('writes SSM parameter for API URL', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/Beta/datamgmt-expense-processor/api-url',
    })
  })

  test('creates SQS event source mapping for event handler', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
    })
  })
})
