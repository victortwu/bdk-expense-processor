#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { ExpenseEventStack } from '../lib/stacks/expense-event-stack'
import { ExpenseApiStack } from '../lib/stacks/expense-api-stack'
import { stages } from '../config'

const app = new cdk.App()

for (const stage of stages) {
  new ExpenseEventStack(app, `${stage.stageName}-BDK-ExpenseProcessorEventStack`, { stage })
  new ExpenseApiStack(app, `${stage.stageName}-BDK-ExpenseProcessorApiStack`, { stage })
}
