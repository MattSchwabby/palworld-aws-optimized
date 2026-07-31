import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { EVENT_ALARMS, alarmCaption, eventCaption, resourceAlarmSpecs } from './alarm-specs';

export interface PalworldDashboardProps {
  readonly dashboardName: string;
  readonly instanceId: string;
  readonly dataVolumeId: string;
  readonly backupBucketName: string;
  readonly serverRegion: string;
  readonly wakeRegion: string;
  /** Only set when addressing is 'route53'. Omit and the wake widget is left out. */
  readonly wakeFunctionName?: string;
  readonly watchdogFunctionName: string;
  /** Memory, swap and disk only exist once enhanced monitoring installs the agent. */
  readonly showMemory: boolean;
  readonly memoryMetricName: string;
  readonly swapMetricName: string;
  readonly diskMetricName: string;
  readonly metricNamespace: string;
  readonly playerMetricName: string;
  readonly backupMetricName: string;
  readonly healthMetricName: string;
  readonly connectAddress: string;
  readonly serverName: string;
  readonly serverPassword: string;
  readonly idleShutdownMinutes: number;
}

/**
 * One CloudWatch dashboard over the metrics this stack already emits.
 *
 * Everything here is free: CloudWatch includes three custom dashboards at no
 * charge, and every widget reads a metric that already exists — the custom player
 * count, plus the no-cost EC2, EBS, S3 and Lambda metrics AWS publishes anyway.
 * There are deliberately no Logs Insights widgets, since those bill per GB scanned.
 *
 * The wake function runs in us-east-1 while everything else is in us-west-2, so
 * those widgets pin their region explicitly.
 */
export class PalworldDashboard extends Construct {
  public readonly dashboardName: string;

  constructor(scope: Construct, id: string, props: PalworldDashboardProps) {
    super(scope, id);

    const players = new cloudwatch.Metric({
      namespace: props.metricNamespace,
      metricName: props.playerMetricName,
      dimensionsMap: { InstanceId: props.instanceId },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
      region: props.serverRegion,
      label: 'Players online',
    });

    const ec2Metric = (metricName: string, statistic: string, label: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName,
        dimensionsMap: { InstanceId: props.instanceId },
        statistic,
        period: cdk.Duration.minutes(5),
        region: props.serverRegion,
        label,
      });

    const lambdaMetric = (
      functionName: string,
      metricName: string,
      region: string,
      label: string,
    ) =>
      new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName,
        dimensionsMap: { FunctionName: functionName },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
        region,
        label,
      });

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: props.dashboardName,
      defaultInterval: cdk.Duration.hours(12),
    });

    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 6,
        markdown: [
          '# Palworld server',
          '',
          `**Address** \`${props.connectAddress}\` &nbsp;&nbsp; **Server name** ${props.serverName} &nbsp;&nbsp; **Password** \`${props.serverPassword || 'none'}\``,
          '',
          'The `:port` is required — Palworld will not connect to a bare hostname.',
          '',
          '### Reading this dashboard',
          '',
          `- **Gaps in every graph mean the server is asleep**, which is the normal, cheap state. It stops itself after ${props.idleShutdownMinutes} minutes with nobody on, and wakes when a player looks up the DNS name.`,
          '- **Players online** is published once a minute by the server itself. If the instance is running but this is flat-lining with no data, the game server is unhealthy — the idle watchdog will stop it.',
          '- **Wake invocations** rising while the instance stays asleep means the DNS trigger fired but the start failed.',
          '- **Watchdog errors** above zero means the cost backstop is broken; check for a server left running unattended.',
          '',
          '_Instance logs are not shipped here. Use `scripts/logs.sh` (requires the instance to be running)._',
        ].join('\n'),
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Players online now',
        width: 6,
        height: 6,
        metrics: [players],
        setPeriodToTimeRange: false,
      }),
      new cloudwatch.GraphWidget({
        title: `Players online (${eventCaption(EVENT_ALARMS.unresponsive, 'if awake and not reporting')})`,
        width: 12,
        height: 6,
        left: [players],
        leftYAxis: { min: 0, label: 'Players', showUnits: false },
      }),
      new cloudwatch.GraphWidget({
        title: 'CPU (t3 burst baseline is 20%/vCPU)',
        width: 6,
        height: 6,
        left: [ec2Metric('CPUUtilization', 'Average', 'CPU %')],
        leftYAxis: { min: 0, max: 100, label: '%', showUnits: false },
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Network (game traffic)',
        width: 12,
        height: 6,
        left: [
          ec2Metric('NetworkIn', 'Sum', 'In'),
          ec2Metric('NetworkOut', 'Sum', 'Out'),
        ],
        leftYAxis: { min: 0, label: 'Bytes', showUnits: false },
      }),
      new cloudwatch.GraphWidget({
        title: 'Save volume I/O',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/EBS',
            metricName: 'VolumeWriteOps',
            dimensionsMap: { VolumeId: props.dataVolumeId },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            region: props.serverRegion,
            label: 'Writes',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/EBS',
            metricName: 'VolumeReadOps',
            dimensionsMap: { VolumeId: props.dataVolumeId },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            region: props.serverRegion,
            label: 'Reads',
          }),
        ],
        leftYAxis: { min: 0, label: 'Ops', showUnits: false },
      }),
    );

    const wakeWidgets: cloudwatch.IWidget[] = [];
    if (props.wakeFunctionName) {
      wakeWidgets.push(
        new cloudwatch.GraphWidget({
          title: `Wake on connect, ${props.wakeRegion} (${eventCaption(EVENT_ALARMS.lambdaErrors, 'on any error')})`,
          width: 8,
          height: 6,
          left: [
            lambdaMetric(props.wakeFunctionName, 'Invocations', props.wakeRegion, 'DNS triggers'),
          ],
          right: [lambdaMetric(props.wakeFunctionName, 'Errors', props.wakeRegion, 'Errors')],
          leftYAxis: { min: 0, showUnits: false },
          rightYAxis: { min: 0, showUnits: false },
        }),
      );
    }

    dashboard.addWidgets(
      ...wakeWidgets,
      new cloudwatch.GraphWidget({
        title: `Idle watchdog, cost backstop (${eventCaption(EVENT_ALARMS.lambdaErrors, 'on any error')})`,
        width: 8,
        height: 6,
        left: [
          lambdaMetric(props.watchdogFunctionName, 'Invocations', props.serverRegion, 'Checks'),
        ],
        right: [
          lambdaMetric(props.watchdogFunctionName, 'Errors', props.serverRegion, 'Errors'),
        ],
        leftYAxis: { min: 0, showUnits: false },
        rightYAxis: { min: 0, showUnits: false },
      }),
      new cloudwatch.GraphWidget({
        title: `Instance status checks, 0 is healthy (${eventCaption(EVENT_ALARMS.statusCheck, 'on any failure')})`,
        width: 8,
        height: 6,
        left: [
          ec2Metric('StatusCheckFailed', 'Maximum', 'Any'),
          ec2Metric('StatusCheckFailed_System', 'Maximum', 'System'),
          ec2Metric('StatusCheckFailed_Instance', 'Maximum', 'Instance'),
        ],
        leftYAxis: { min: 0, showUnits: false },
      }),
    );

    // Memory is the signal that matters most on a 4 GB box, and it only exists once
    // enhanced monitoring installs the agent that publishes it.
    //
    // Each chart draws its alarm threshold as a red line captioned with the exact
    // firing condition, so you can read "how close am I" straight off the graph.
    // Both the line and the caption come from the same spec the alarms are built
    // from, so they cannot drift apart.
    if (props.showMemory) {
      const specs = resourceAlarmSpecs();
      const byMetric = (metricName: string) => specs.find((s) => s.metricName === metricName);

      const agentMetric = (metricName: string, label: string) =>
        new cloudwatch.Metric({
          namespace: props.metricNamespace,
          metricName,
          dimensionsMap: { InstanceId: props.instanceId },
          statistic: 'Average',
          period: cdk.Duration.minutes(1),
          region: props.serverRegion,
          label,
        });

      const annotation = (
        metricName: string,
        color: string,
      ): cloudwatch.HorizontalAnnotation[] => {
        const spec = byMetric(metricName);
        if (!spec) {
          return [];
        }
        return [
          {
            value: spec.threshold,
            label: `${spec.title}: ${alarmCaption(spec)}`,
            color,
            // Shade the breaching region rather than just drawing a line, so a
            // series creeping into it is obvious at a glance.
            fill: cloudwatch.Shading.ABOVE,
          },
        ];
      };

      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Memory and swap (watch this on 4 GB)',
          width: 12,
          height: 6,
          left: [
            agentMetric(props.memoryMetricName, 'Memory %'),
            agentMetric(props.swapMetricName, 'Swap %'),
          ],
          leftAnnotations: [
            ...annotation(props.memoryMetricName, cloudwatch.Color.RED),
            ...annotation(props.swapMetricName, cloudwatch.Color.ORANGE),
          ],
          leftYAxis: { min: 0, max: 100, label: '%', showUnits: false },
        }),
        new cloudwatch.GraphWidget({
          title: 'Root disk used',
          width: 12,
          height: 6,
          left: [agentMetric(props.diskMetricName, 'Disk %')],
          leftAnnotations: annotation(props.diskMetricName, cloudwatch.Color.RED),
          leftYAxis: { min: 0, max: 100, label: '%', showUnits: false },
        }),
      );
    }

    // Two different things, deliberately split.
    //
    // The first plots the heartbeat the BackupsStalled alarm actually watches, so
    // the caption and the line refer to the same metric. It updates every 15
    // minutes.
    //
    // The second uses S3's storage metrics, which AWS meters once a day. On a fresh
    // bucket they show nothing for up to 48 hours. That is normal and says nothing
    // about whether backups are running, which is why the alarm does not use them.
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: `Backup uploads (${eventCaption(EVENT_ALARMS.backupsStalled, 'if awake with no upload')})`,
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: props.metricNamespace,
            metricName: props.backupMetricName,
            dimensionsMap: { InstanceId: props.instanceId },
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
            region: props.serverRegion,
            label: 'Successful uploads',
          }),
        ],
        leftYAxis: { min: 0, label: 'Uploads', showUnits: false },
      }),
      new cloudwatch.GraphWidget({
        title: 'Stored in S3 (AWS meters this daily, so a new bucket is blank for up to 48h)',
        width: 12,
        height: 6,
        start: '-P14D',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/S3',
            metricName: 'NumberOfObjects',
            dimensionsMap: {
              BucketName: props.backupBucketName,
              StorageType: 'AllStorageTypes',
            },
            statistic: 'Average',
            period: cdk.Duration.days(1),
            region: props.serverRegion,
            label: 'Archives kept',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/S3',
            metricName: 'BucketSizeBytes',
            dimensionsMap: {
              BucketName: props.backupBucketName,
              StorageType: 'StandardStorage',
            },
            statistic: 'Average',
            period: cdk.Duration.days(1),
            region: props.serverRegion,
            label: 'Bytes',
          }),
        ],
        leftYAxis: { min: 0, label: 'Count', showUnits: false },
        rightYAxis: { min: 0, label: 'Bytes', showUnits: false },
      }),
    );

    this.dashboardName = props.dashboardName;
  }
}
