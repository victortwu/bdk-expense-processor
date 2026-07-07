import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { ExpenseApiStack } from '../lib/stacks/expense-api-stack'

const createStack = () => {
  const app = new cdk.App()
  const stack = new ExpenseApiStack(app, 'TestStack', {
    stage: { stageName: 'Beta' },
  })
  return Template.fromStack(stack)
}

describe('ExpenseApiStack', () => {
  let template: Template

  beforeAll(() => {
    template = createStack()
  })

  test('synthesizes without errors', () => {
    expect(template).toBeDefined()
  })

  test('creates API Lambda', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'Beta-BDK-ExpenseProcessor-Api',
      Timeout: 30,
    })
  })

  test('creates API Gateway HTTP API', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'Beta-BDK-ExpenseProcessor',
      ProtocolType: 'HTTP',
    })
  })

  test('creates all 11 API routes', () => {
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
})
