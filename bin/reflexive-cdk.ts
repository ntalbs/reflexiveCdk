#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ReflexiveRsEc2Stack } from '../lib/reflexive-rs-ec2-stack';
import { ReflexiveJavaEc2Stack } from '../lib/reflexive-java-ec2-stack';

const app = new cdk.App();
new ReflexiveRsEc2Stack(app, 'ReflexiveRustEc2Stack');
new ReflexiveJavaEc2Stack(app, 'ReflexiveJavaEc2Stack')