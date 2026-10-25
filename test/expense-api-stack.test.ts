import * as cdk from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
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

  test('creates all 12 API routes', () => {
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
    expect(routeKeys).toContain('POST /expenses/{documentId}/correct-and-submit')
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

  // ─── BDK #7 — manual-path PDF attachment (env + cross-stack grants) ────────

  test('API Lambda has PROCESSED_BUCKET env', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'Beta-BDK-ExpenseProcessor-Api',
      Environment: {
        Variables: Match.objectLike({
          PROCESSED_BUCKET: Match.anyValue(),
        }),
      },
    })
  })

  test('API Lambda role gets s3:GetObject on the processed bucket', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['s3:GetObject*', 's3:GetBucket*', 's3:List*']),
          }),
        ]),
      },
    })
  })

  test('API Lambda role gets kms:Decrypt (processing key, for PDF decrypt)', () => {
    // Two Decrypt statements exist (expense-processor key + processing key). We
    // assert at least one Decrypt grant is present (scoped to a key ARN, not '*').
    const policies = template.findResources('AWS::IAM::Policy')
    const decryptStatements = Object.values(policies).flatMap((p: Record<string, unknown>) => {
      const statements = (
        p as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
      ).Properties.PolicyDocument.Statement
      return statements.filter((s) => {
        const action = s.Action
        const actions = Array.isArray(action) ? action : [action]
        return actions.includes('kms:Decrypt')
      })
    })
    expect(decryptStatements.length).toBeGreaterThanOrEqual(2)
    // None of the Decrypt grants use a wildcard resource.
    for (const s of decryptStatements) {
      expect(s.Resource).not.toBe('*')
    }
  })
})
