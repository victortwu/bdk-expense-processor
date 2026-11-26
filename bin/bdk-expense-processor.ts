#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { createStacks } from '../lib/create-stacks'
import { stages } from '../config'

createStacks(new cdk.App(), stages)
