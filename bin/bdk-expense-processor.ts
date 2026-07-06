#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { ExpenseProcessorStack } from '../lib/stacks/expense-processor-stack'
import { stages } from '../config'

const app = new cdk.App()

for (const stage of stages) {
  new ExpenseProcessorStack(app, `${stage.stageName}-BDK-ExpenseProcessorStack`, { stage })
}
