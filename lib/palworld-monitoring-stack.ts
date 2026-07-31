import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { config } from './active-config';
import { EVENT_ALARMS, alarmCaption, eventCaption, resourceAlarmSpecs } from './alarm-specs';
import { BACKUP_METRIC, HEALTH_METRIC, METRIC_NAMESPACE, PLAYER_METRIC } from './metrics';

export interface PalworldMonitoringStackProps extends cdk.StackProps {
  readonly instanceId: string;
}

/**
 * Alarms for the things that actually break.
 *
 * Optional, and off by default, because it costs money where the rest of the
 * monitoring does not. Custom metrics run $0.30 each per month, alarms $0.10 each,
 * log ingestion $0.50/GB. Call it $2/month.
 *
 * Worth having on 4 GB. Pocketpair warn that running short on memory corrupts
 * saves, and a memory alarm is the only warning you get before that happens. The
 * agent that publishes those metrics gets installed by the instance's bootstrap
 * when enhancedMonitoring is switched on.
 *
 * Everything here is regional, which is why the wake function's own error alarm
 * lives in the wake stack instead. CloudWatch alarms cannot read metrics from
 * another region.
 */
export class PalworldMonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PalworldMonitoringStackProps) {
    super(scope, id, props);

    const settings = config.enhancedMonitoring;

    const topic = new sns.Topic(this, 'Alerts', {
      displayName: 'Palworld server alerts',
    });

    if (settings.alertEmail) {
      // AWS emails a confirmation link. Alarms stay silent until it is clicked.
      topic.addSubscription(new subscriptions.EmailSubscription(settings.alertEmail));
    }

    const alarmAction = new actions.SnsAction(topic);

    const agentMetric = (metricName: string, label: string) =>
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName,
        dimensionsMap: { InstanceId: props.instanceId },
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
        label,
      });

    // Built from the same specs the dashboard draws its threshold lines from, so a
    // chart can never show a line the alarm does not actually fire on.
    for (const spec of resourceAlarmSpecs()) {
      const created = new cloudwatch.Alarm(this, spec.id, {
        metric: new cloudwatch.Metric({
          namespace: METRIC_NAMESPACE,
          metricName: spec.metricName,
          dimensionsMap: { InstanceId: props.instanceId },
          statistic: 'Average',
          period: cdk.Duration.minutes(spec.periodMinutes),
        }),
        threshold: spec.threshold,
        evaluationPeriods: spec.evaluationPeriods,
        // Set explicitly rather than defaulted, so the "M of N" caption on the
        // dashboard stays true if either number is ever changed.
        datapointsToAlarm: spec.datapointsToAlarm,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: `${alarmCaption(spec)}. ${spec.rationale}`,
        // A sleeping server publishes nothing, and that is the normal state here.
        // Treating gaps as breaching would page you every night.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      created.addAlarmAction(alarmAction);
    }

    // Hardware or hypervisor trouble underneath the instance.
    const statusCheck = new cloudwatch.Alarm(this, 'StatusCheckFailed', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed',
        dimensionsMap: { InstanceId: props.instanceId },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      evaluationPeriods: EVENT_ALARMS.statusCheck.evaluationPeriods,
      datapointsToAlarm: EVENT_ALARMS.statusCheck.datapointsToAlarm,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `EC2 status checks failing: ${eventCaption(EVENT_ALARMS.statusCheck, 'on any failure')}.`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    statusCheck.addAlarmAction(alarmAction);

    // If the backstop breaks, a server can sit running with nobody on it and bill
    // all month. This is the alarm that protects your wallet.
    const watchdogErrors = new cloudwatch.Alarm(this, 'WatchdogErrors', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: { FunctionName: config.watchdogFunctionName },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: EVENT_ALARMS.lambdaErrors.evaluationPeriods,
      datapointsToAlarm: EVENT_ALARMS.lambdaErrors.datapointsToAlarm,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `The idle watchdog is failing, so cost control may be broken: ${eventCaption(EVENT_ALARMS.lambdaErrors, 'on any error')}.`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    watchdogErrors.addAlarmAction(alarmAction);

    // A running instance that reports no player count is an unhealthy game server.
    // Distinct from a sleeping one, which reports nothing because it is off.
    const unhealthy = new cloudwatch.Alarm(this, 'ServerUnresponsive', {
      metric: new cloudwatch.MathExpression({
        // CPUUtilization exists for every period the instance is up and is absent
        // while it sleeps, so it stands in for "the box is on". GameServerUp is 1
        // only when the game's own API answers.
        //
        // FILL(up, 0) covers both failure shapes with one expression: the game
        // reporting 0 because it is dead, and nothing reporting at all because the
        // agent itself has stopped running.
        //
        // While the instance is stopped, cpu has no datapoint, the whole expression
        // is a gap, and NOT_BREACHING keeps the alarm quiet. That is what separates
        // a sleeping server from a broken one.
        expression: 'IF(cpu > 0 AND FILL(up, 0) < 1, 1, 0)',
        usingMetrics: {
          cpu: new cloudwatch.Metric({
            namespace: 'AWS/EC2',
            metricName: 'CPUUtilization',
            dimensionsMap: { InstanceId: props.instanceId },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
          up: new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: HEALTH_METRIC,
            dimensionsMap: { InstanceId: props.instanceId },
            statistic: 'Minimum',
            period: cdk.Duration.minutes(5),
          }),
        },
        period: cdk.Duration.minutes(5),
        label: 'Running but not reporting',
      }),
      threshold: 0,
      evaluationPeriods: EVENT_ALARMS.unresponsive.evaluationPeriods,
      datapointsToAlarm: EVENT_ALARMS.unresponsive.datapointsToAlarm,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `Instance running but the game has reported no player count: ${eventCaption(EVENT_ALARMS.unresponsive, 'while awake')}.`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    unhealthy.addAlarmAction(alarmAction);

    // Backups are the only defence against a corrupted save, and a corrupted save is
    // the failure the EBS volume cannot help with, since it replicates corruption
    // faithfully. A backup job that quietly stops leaves you believing you are
    // covered when you are not.
    //
    // The metric is published on every successful upload. Absence is the signal, so
    // this alarm is the one place where missing data has to breach. Scoped to
    // periods where CPU exists, meaning the instance is awake and should be backing
    // up, so a sleeping server stays quiet.
    const backupsStalled = new cloudwatch.Alarm(this, 'BackupsStalled', {
      metric: new cloudwatch.MathExpression({
        expression: 'IF(cpu > 0 AND FILL(backups, 0) < 1, 1, 0)',
        usingMetrics: {
          cpu: new cloudwatch.Metric({
            namespace: 'AWS/EC2',
            metricName: 'CPUUtilization',
            dimensionsMap: { InstanceId: props.instanceId },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
          backups: new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: BACKUP_METRIC,
            dimensionsMap: { InstanceId: props.instanceId },
            statistic: 'SampleCount',
            period: cdk.Duration.minutes(5),
          }),
        },
        period: cdk.Duration.minutes(5),
        label: 'Awake with no backup',
      }),
      threshold: 0,
      // Backups run every 15 minutes, so allow a couple of intervals before
      // complaining.
      evaluationPeriods: EVENT_ALARMS.backupsStalled.evaluationPeriods,
      datapointsToAlarm: EVENT_ALARMS.backupsStalled.datapointsToAlarm,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `Awake with no successful backup to S3: ${eventCaption(EVENT_ALARMS.backupsStalled, 'while awake')}.`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    backupsStalled.addAlarmAction(alarmAction);

    new cdk.CfnOutput(this, 'AlertTopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'AlertEmail', {
      value: settings.alertEmail || '(none, watch the console)',
      description: 'Confirm the subscription from your inbox before alarms can notify you',
    });
    new cdk.CfnOutput(this, 'InstanceLogsUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#logsV2:log-groups/log-group/$252Fpalworld$252Finstance`,
      description: 'Game server and bootstrap logs shipped from the instance',
    });
  }
}
