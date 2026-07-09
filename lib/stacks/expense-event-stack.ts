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
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import { Bucket } from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import * as path from 'path'
import { StageConfig } from '../../config'

interface ExpenseEventStackProps extends cdk.StackProps {
  stage: StageConfig
}

export class ExpenseEventStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ExpenseEventStackProps) {
    super(scope, id, props)

    const { stage } = props
    const stageName = stage.stageName
    const stageLower = stageName.toLowerCase()

    // ─── SSM Imports ───────────────────────────────────────────────────────────

    const qboServiceUrl = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt-qbo/api-url`,
    )
    const processedBucketName = ssm.StringParameter.valueForStringParameter(
      this,
      `/${stageName}/datamgmt/processed-bucket-name`,
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
        COGNITO_TOKEN_URL: `https://parsely-${stageLower}.auth.${this.region}.amazoncognito.com/oauth2/token`,
        MACHINE_CLIENT_ID: machineClientId,
        MACHINE_CLIENT_SECRET: machineClientSecret,
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

    // ─── SSM Outputs (for API stack to import) ─────────────────────────────────

    new ssm.StringParameter(this, 'TableNameParam', {
      parameterName: `/${stageName}/datamgmt-expense-processor/table-name`,
      stringValue: table.tableName,
      description: `BDK Expense Processor table name (${stageName})`,
    })

    new ssm.StringParameter(this, 'KmsKeyArnParam', {
      parameterName: `/${stageName}/datamgmt-expense-processor/kms-key-arn`,
      stringValue: key.keyArn,
      description: `BDK Expense Processor KMS key ARN (${stageName})`,
    })
  }
}
