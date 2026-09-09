import * as cdk from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import { Construct } from 'constructs'
import * as path from 'path'
import { StageConfig } from '../../config'

interface ExpenseApiStackProps extends cdk.StackProps {
  stage: StageConfig
}

export class ExpenseApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ExpenseApiStackProps) {
    super(scope, id, props)

    const { stage } = props
    const stageName = stage.stageName

    // ─── SSM Imports ───────────────────────────────────────────────────────────

    const userPoolId = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt/user-pool-id`,
    )
    const userPoolClientId = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt/user-pool-client-id`,
    )
    const machineClientId = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt/machine-client-id`,
    )
    // Note: Using String (not SecureString) because CloudFormation doesn't support
    // ssm-secure references in Lambda env vars. This is an internal M2M secret
    // within the same AWS account — acceptable security posture for Beta.
    const machineClientSecret = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt/machine-client-secret-string`,
    )
    const qboServiceUrl = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt-qbo/api-url`,
    )

    // Import from Event Stack
    const tableName = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt-expense-processor/table-name`,
    )
    const kmsKeyArn = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt-expense-processor/kms-key-arn`,
    )

    // ─── Import Shared Resources ───────────────────────────────────────────────

    const table = dynamodb.Table.fromTableAttributes(this, 'ExpenseTable', {
      tableName,
      grantIndexPermissions: true,
    })

    const key = kms.Key.fromKeyArn(this, 'ExpenseProcessorKey', kmsKeyArn)

    // ─── API Lambda ────────────────────────────────────────────────────────────

    const apiLambda = new lambda.NodejsFunction(this, 'ApiLambda', {
      entry: path.join(__dirname, '../../lambdas/api/index.ts'),
      functionName: `${stageName}-BDK-ExpenseProcessor-Api`,
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: tableName,
        QBO_SERVICE_URL: qboServiceUrl,
        COGNITO_TOKEN_URL: `https://parsely-${stageName.toLowerCase()}.auth.${this.region}.amazoncognito.com/oauth2/token`,
        MACHINE_CLIENT_ID: machineClientId,
        MACHINE_CLIENT_SECRET: machineClientSecret,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    })

    table.grantReadWriteData(apiLambda)
    key.grantDecrypt(apiLambda)
    key.grantEncrypt(apiLambda)

    // ─── API Gateway ───────────────────────────────────────────────────────────

    const httpApi = new apigwv2.HttpApi(this, 'ExpenseProcessorApi', {
      apiName: `${stageName}-BDK-ExpenseProcessor`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    })

    // JWT Authorizer (reuses shared Cognito pool)
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}`
    const jwtAuthorizer = new apigwv2Authorizers.HttpJwtAuthorizer('JwtAuthorizer', issuer, {
      jwtAudience: [userPoolClientId, machineClientId],
    })

    // Integration
    const apiIntegration = new apigwv2Integrations.HttpLambdaIntegration(
      'ApiIntegration',
      apiLambda,
    )

    // Expense routes
    httpApi.addRoutes({
      path: '/expenses',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })
    httpApi.addRoutes({
      path: '/expenses/{documentId}',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })
    httpApi.addRoutes({
      path: '/expenses/submit',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })
    httpApi.addRoutes({
      path: '/expenses/retry',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })
    httpApi.addRoutes({
      path: '/expenses/skip',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })
    httpApi.addRoutes({
      path: '/expenses/approve-vendor',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })
    httpApi.addRoutes({
      path: '/expenses/set-account',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })

    // Rules routes
    httpApi.addRoutes({
      path: '/rules',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })
    httpApi.addRoutes({
      path: '/rules/{vendorName}',
      methods: [apigwv2.HttpMethod.PUT],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })
    httpApi.addRoutes({
      path: '/rules/{vendorName}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })

    // Stats route
    httpApi.addRoutes({
      path: '/stats',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    })

    // ─── Outputs ───────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'BDK Expense Processor API URL',
    })

    new ssm.StringParameter(this, 'ApiUrlParam', {
      parameterName: `/${stageName}/datamgmt-expense-processor/api-url`,
      stringValue: httpApi.apiEndpoint,
      description: `BDK Expense Processor API URL (${stageName})`,
    })
  }
}
