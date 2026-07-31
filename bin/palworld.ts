#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { assertUnixLineEndings } from '../lib/assert-lf';
import { assertConfigured, config } from '../lib/active-config';
import { PalworldMonitoringStack } from '../lib/palworld-monitoring-stack';
import { PalworldServerStack } from '../lib/palworld-server-stack';
import { PalworldWakeStack } from '../lib/palworld-wake-stack';

// Fails fast and loudly if the template's placeholders are still in place, rather
// than letting them reach CloudFormation.
assertConfigured();

// A CRLF shebang in server/ breaks the instance bootstrap on its next boot, and the
// instance re-downloads these files every time, so it cannot be fixed on the box.
// Catch it here instead of shipping it.
assertUnixLineEndings(path.join(__dirname, '..', 'server'));

const app = new cdk.App();

const serverEnv = { account: config.account, region: config.region };

// Wake-on-connect only exists when a domain is delegated to Route 53. With an
// Elastic IP there is no DNS lookup to trigger on, so the start page and
// scripts/start.sh do that job instead.
let queryLogGroupArn: string | undefined;
let wake: PalworldWakeStack | undefined;

if (config.addressing === 'route53') {
  // Route 53 writes query logs only to us-east-1, and only to a log group whose
  // name begins with /aws/route53/. Both stacks derive the same name from config
  // rather than passing a token between regions.
  const queryLogGroupName = `/aws/route53/${config.domainName}`;
  queryLogGroupArn = `arn:aws:logs:${config.dnsRegion}:${config.account}:log-group:${queryLogGroupName}`;

  wake = new PalworldWakeStack(app, 'PalworldWake', {
    env: { account: config.account, region: config.dnsRegion },
    description: 'Wake on connect: a DNS query for the server starts the instance',
    logGroupName: queryLogGroupName,
    targetRegion: config.region,
    recordName: config.domainName,
    wakeFunctionName: config.wakeFunctionName,
    enhancedMonitoring: config.enhancedMonitoring.enabled,
    alertEmail: config.enhancedMonitoring.alertEmail,
  });
}

const server = new PalworldServerStack(app, 'PalworldServer', {
  env: serverEnv,
  description: 'Palworld dedicated server: EC2, persistent save volume, S3 backups',
  queryLogGroupArn,
});

if (wake) {
  // The hosted zone points its query logs at that log group, so it has to exist
  // first.
  server.addStackDependency(wake);
}

if (config.enhancedMonitoring.enabled) {
  const monitoring = new PalworldMonitoringStack(app, 'PalworldMonitoring', {
    env: serverEnv,
    description: 'Optional alarms for memory, disk, and the cost backstop',
    instanceId: server.instanceId,
  });
  monitoring.addStackDependency(server);
}

// The wake function, the start page, and the watchdog all find the instance by this
// tag, and the IAM policies that let them start and stop it are conditioned on it.
cdk.Tags.of(app).add('Application', 'palworld');
cdk.Tags.of(app).add('ManagedBy', 'cdk');
