import * as cdk from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources'
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import { Bucket } from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import * as path from 'path'
import { StageConfig } from '../../config'

interface ExpenseProcessorStackProps extends cdk.StackProps {
  stage: StageConfig
}

export class ExpenseProcessorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ExpenseProcessorStackProps) {
    super(scope, id, props)

    const { stage } = props
    const stageName = stage.stageName
    const stageLower = stageName.toLowerCase()

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
    const qboServiceUrl = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt-qbo/api-url`,
    )
    const processedBucketName = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt/processed-bucket-name`,
    )

    // ─── KMS Key ───────────────────────────────────────────────────────────────

    const key = new kms.Key(this, 'ExpenseProcessorKey', {
      alias: `datamgmt-expense-processor-${stageLower}`,
      enableKeyRotation: true,
      description: `BDK Expense Processor encryption key (${stageName})`,
    })

    // ─── DynamoDB Table (single-table design) ──────────────────────────────────

    const table = new dynamodb.Table(this, 'ExpenseTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    table.addGlobalSecondaryIndex({
      indexName: 'ByStatus',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
    })

    // ─── SQS Dead Letter Queue ─────────────────────────────────────────────────

    const dlq = new sqs.Queue(this, 'ExpenseProcessorDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
    })

    // ─── SQS Queue ─────────────────────────────────────────────────────────────

    const queue = new sqs.Queue(this, 'ExpenseProcessorQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: dlq,
      },
    })

    // ─── EventBridge Rule ──────────────────────────────────────────────────────

    new events.Rule(this, 'DocumentProcessedRule', {
      eventPattern: {
        source: ['parsely.processing'],
        detailType: ['DocumentProcessed'],
        detail: {
          documentType: ['financial'],
          subType: ['invoice', 'receipt'],
        },
      },
      targets: [new eventsTargets.SqsQueue(queue)],
    })

    // ─── S3 Processed Bucket (imported) ────────────────────────────────────────

    const processedBucket = Bucket.fromBucketName(
      this,
      'ProcessedBucket',
      processedBucketName,
    )

    // ─── Event Handler Lambda ──────────────────────────────────────────────────

    const eventHandlerLambda = new lambda.NodejsFunction(this, 'EventHandlerLambda', {
      entry: path.join(__dirname, '../../lambdas/event-handler/index.ts'),
      functionName: `${stageName}-BDK-ExpenseProcessor-EventHandler`,
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      environment: {
        TABLE_NAME: table.tableName,
        PROCESSED_BUCKET: processedBucketName,
        QBO_SERVICE_URL: qboServiceUrl,
        ORDERGOODS_API_URL: stage.ordergoodsApiUrl || '',
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    })

    table.grantReadWriteData(eventHandlerLambda)
    processedBucket.grantRead(eventHandlerLambda)
    key.grantDecrypt(eventHandlerLambda)
    key.grantEncrypt(eventHandlerLambda)

    // Bedrock InvokeModel permission (for line-item extraction)
    eventHandlerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['arn:aws:bedrock:*::foundation-model/us.amazon.nova-lite-v1:0'],
      }),
    )

    // EventBridge PutEvents permission (for notifications)
    eventHandlerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [`arn:aws:events:${this.region}:${this.account}:event-bus/default`],
      }),
    )

    eventHandlerLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(queue, {
        batchSize: 1,
      }),
    )

    // ─── API Lambda ────────────────────────────────────────────────────────────

    const apiLambda = new lambda.NodejsFunction(this, 'ApiLambda', {
      entry: path.join(__dirname, '../../lambdas/api/index.ts'),
      functionName: `${stageName}-BDK-ExpenseProcessor-Api`,
      runtime: Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
        QBO_SERVICE_URL: qboServiceUrl,
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

    // Vendor approval + account selection routes
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
