import * as cdk from 'aws-cdk-lib'
import { StageConfig } from '../config'
import { ExpenseApiStack } from './stacks/expense-api-stack'
import { ExpenseEventStack } from './stacks/expense-event-stack'

/** Instantiates the event and API stacks for every stage. Shared by bin/ and tests. */
export const createStacks = (
  app: cdk.App,
  stages: StageConfig[],
): { event: ExpenseEventStack; api: ExpenseApiStack }[] =>
  stages.map((stage) => ({
    event: new ExpenseEventStack(app, `${stage.stageName}-BDK-ExpenseProcessorEventStack`, {
      stage,
      env: stage.env,
    }),
    api: new ExpenseApiStack(app, `${stage.stageName}-BDK-ExpenseProcessorApiStack`, {
      stage,
      env: stage.env,
    }),
  }))
