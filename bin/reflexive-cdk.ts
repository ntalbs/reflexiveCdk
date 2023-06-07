#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ReflexiveCdkStack } from '../lib/reflexive_cdk-stack';

const app = new cdk.App();
new ReflexiveCdkStack(app, 'ReflexiveCdkStack');