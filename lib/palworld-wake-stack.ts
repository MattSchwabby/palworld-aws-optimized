import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface PalworldWakeStackProps extends cdk.StackProps {
  /** Must start with /aws/route53/ — Route 53 refuses to write anywhere else. */
  readonly logGroupName: string;
  /** Region the game server actually runs in. */
  readonly targetRegion: string;
  /** Fully-qualified name players resolve, e.g. palworld.example.com */
  readonly recordName: string;
  /** Fixed function name, so the dashboard in the server region can reference it. */
  readonly wakeFunctionName: string;
  /** When true, add an error alarm here, since alarms cannot cross regions. */
  readonly enhancedMonitoring: boolean;
  /** Empty string creates the topic without a subscription. */
  readonly alertEmail?: string;
}

/**
 * Wake-on-connect.
 *
 * A stopped EC2 instance has no network interface, so nothing in AWS ever sees a
 * player's connection attempt — there is no packet to trigger on, and a UDP load
 * balancer with no healthy targets is both an unreliable trigger and ~$16/month.
 * What *is* observable is the DNS lookup that necessarily precedes the connection.
 * Route 53 logs every query for the delegated zone; a subscription filter turns
 * the one we care about into a Lambda invocation that starts the instance.
 *
 * Pinned to us-east-1 because Route 53 query logging can only write to CloudWatch
 * Logs there. The Lambda reaches across to start an instance in `targetRegion`.
 *
 * This stack deliberately knows nothing about the server stack: it finds the
 * instance by tag at runtime rather than taking an ID at synth time. That avoids a
 * dependency cycle (the hosted zone needs this log group; a Lambda holding an
 * instance ID would need the hosted zone's stack) and means a replaced instance
 * keeps working without redeploying anything here.
 */
export class PalworldWakeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PalworldWakeStackProps) {
    super(scope, id, props);

    const queryLogGroup = new logs.LogGroup(this, 'QueryLogs', {
      logGroupName: props.logGroupName,
      // These logs are a trigger mechanism, not an audit trail.
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Route 53 writes here as a service principal, which needs a Logs resource
    // policy rather than an IAM role. The ARN deliberately has no trailing ":*" —
    // Route 53 rejects the wildcard form CloudWatch normally uses.
    new logs.CfnResourcePolicy(this, 'Route53LogAccess', {
      policyName: 'palworld-route53-query-logging',
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'Route53QueryLogging',
            Effect: 'Allow',
            Principal: { Service: 'route53.amazonaws.com' },
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/route53/*`,
            Condition: {
              StringEquals: { 'aws:SourceAccount': this.account },
              // Cannot name the specific zone without creating a cycle; the
              // account condition already prevents cross-account writes.
              ArnLike: { 'aws:SourceArn': 'arn:aws:route53:::hostedzone/*' },
            },
          },
        ],
      }),
    });

    // ---- The waker --------------------------------------------------------
    const waker = new lambda.Function(this, 'WakeFunction', {
      // Fixed so the dashboard in the other region can name it. See config.ts.
      functionName: props.wakeFunctionName,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/wake'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      description: 'Starts the Palworld EC2 instance when its DNS name is queried',
      environment: { TARGET_REGION: props.targetRegion },
      logGroup: new logs.LogGroup(this, 'WakeFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    waker.addToRolePolicy(
      new iam.PolicyStatement({
        // Neither action supports resource-level scoping for the lookup itself.
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }),
    );
    waker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StartInstances'],
        resources: ['*'],
        conditions: { StringEquals: { 'ec2:ResourceTag/Application': 'palworld' } },
      }),
    );

    // Route 53 query log lines are space-delimited plain text; a quoted term is a
    // substring match. Filtering here rather than inside the Lambda means
    // unrelated queries never cost an invocation.
    new logs.SubscriptionFilter(this, 'WakeOnQuery', {
      logGroup: queryLogGroup,
      destination: new destinations.LambdaDestination(waker),
      filterPattern: logs.FilterPattern.literal(`"${props.recordName}"`),
    });

    // Alarms are regional, and this function runs in us-east-1 while the rest of the
    // monitoring sits in the server's region, so its alarm has to live here. A
    // failing waker means players cannot start the server at all.
    if (props.alertEmail !== undefined && props.enhancedMonitoring) {
      const topic = new sns.Topic(this, 'WakeAlerts', {
        displayName: 'Palworld wake function alerts',
      });
      if (props.alertEmail) {
        topic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
      }

      const errors = new cloudwatch.Alarm(this, 'WakeErrors', {
        metric: waker.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 0,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: 'The wake function is failing. Players cannot start the server.',
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      errors.addAlarmAction(new actions.SnsAction(topic));

      new cdk.CfnOutput(this, 'WakeAlertTopicArn', { value: topic.topicArn });
    }

    new cdk.CfnOutput(this, 'WakeFunctionName', { value: waker.functionName });
    new cdk.CfnOutput(this, 'QueryLogGroup', { value: props.logGroupName });
  }
}
