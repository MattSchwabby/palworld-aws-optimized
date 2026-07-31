import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';
import { config } from './active-config';
import {
  BACKUP_METRIC,
  DISK_METRIC,
  INSTANCE_LOG_GROUP,
  MEMORY_METRIC,
  METRIC_NAMESPACE,
  PLAYER_METRIC,
  RUNTIME_PARAM_NAME,
  HEALTH_METRIC,
  SWAP_METRIC,
} from './metrics';
import { PalworldDashboard } from './palworld-dashboard';

// Re-exported so existing imports keep working; the definitions live in metrics.ts
// to keep the dashboard and alarm specs free of a dependency on this file.
export {
  BACKUP_METRIC,
  DISK_METRIC,
  INSTANCE_LOG_GROUP,
  MEMORY_METRIC,
  METRIC_NAMESPACE,
  PLAYER_METRIC,
  RUNTIME_PARAM_NAME,
  SWAP_METRIC,
} from './metrics';

export interface PalworldServerStackProps extends cdk.StackProps {
  /**
   * CloudWatch Logs group in us-east-1 that Route 53 writes query logs to. Those
   * queries are what wake the server, so this is required when addressing is
   * 'route53' and unused otherwise.
   */
  readonly queryLogGroupArn?: string;
}

/**
 * The game server and everything it needs: an instance, a save volume that outlives
 * it, backups, and whichever addressing mode you picked.
 */
export class PalworldServerStack extends cdk.Stack {
  public readonly instanceId: string;
  public readonly dataVolumeId: string;
  public readonly backupBucketName: string;

  constructor(scope: Construct, id: string, props: PalworldServerStackProps = {}) {
    super(scope, id, props);

    const usingRoute53 = config.addressing === 'route53';

    // ---- Network ----------------------------------------------------------
    // Public subnet, no NAT gateway. A NAT would cost around $32/month, more than
    // the game server itself, and the instance needs a public address anyway so
    // players can reach it.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const subnet = vpc.publicSubnets[0];

    const securityGroup = new ec2.SecurityGroup(this, 'ServerSg', {
      vpc,
      description: 'Palworld game traffic',
      allowAllOutbound: true,
    });
    // Palworld speaks UDP. Open TCP on this port instead and the server will start,
    // log cleanly, and accept nobody.
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(config.gamePort),
      'Palworld game traffic',
    );
    if (config.communityServer.enabled && config.communityServer.queryPort > 0) {
      // Needed for the in-game Community Servers browser to see the server, which
      // is the only route consoles have since they cannot type an address.
      securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.udp(config.communityServer.queryPort),
        'Palworld community server browser query',
      );
    }
    // No SSH rule, and no key pair anywhere in this stack. Shell access goes through
    // SSM Session Manager, which tunnels over the instance's outbound connection.

    // ---- Persistent save data --------------------------------------------
    // Its own volume, not the root disk, and retained on delete. Replacing the
    // instance or tearing down the stack leaves your world where it is.
    const dataVolume = new ec2.Volume(this, 'SaveData', {
      availabilityZone: subnet.availabilityZone,
      size: cdk.Size.gibibytes(config.dataVolumeGb),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      volumeName: 'palworld-save-data',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---- Backups ----------------------------------------------------------
    // Covers what a volume cannot: a save corrupted by an out-of-memory kill, which
    // EBS would happily keep. Timestamped archives let you go back to before it.
    const backupBucket = new s3.Bucket(this, 'Backups', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-old-saves',
          prefix: 'saves/',
          expiration: cdk.Duration.days(config.backupExpiryDays),
        },
        {
          id: 'abort-incomplete-uploads',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    // ---- Instance log group ----------------------------------------------
    // Created here rather than in the monitoring stack so the Docker log driver
    // never races CloudFormation for it. Empty log groups cost nothing, and the
    // instance only writes here when enhanced monitoring is switched on.
    const instanceLogs = new logs.LogGroup(this, 'InstanceLogs', {
      logGroupName: INSTANCE_LOG_GROUP,
      // RetentionDays is a numeric enum, so a plain day count works as long as it
      // matches one of the values CloudWatch accepts.
      retention: config.enhancedMonitoring.logRetentionDays as logs.RetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- Addressing -------------------------------------------------------
    let zone: route53.PublicHostedZone | undefined;
    let elasticIp: ec2.CfnEIP | undefined;
    // What a player is told to type or search for. In 'server-list' mode nothing is
    // allocated, so this is an instruction rather than a host and port.
    let connectAddress: string;

    if (usingRoute53) {
      if (!props.queryLogGroupArn) {
        throw new Error('addressing is "route53" but queryLogGroupArn was not provided');
      }

      // A hosted zone for the delegated subdomain alone. Your apex domain stays
      // wherever it is now.
      zone = new route53.PublicHostedZone(this, 'Zone', {
        zoneName: config.domainName,
        comment: 'Palworld server. Delegated from your registrar via NS records.',
        // Logging every lookup is what makes wake-on-connect work.
        queryLogsLogGroupArn: props.queryLogGroupArn,
      });

      // Parked so the name always answers with something. Were the record simply
      // absent, the first attempt would return NXDOMAIN, and resolvers cache that
      // for the zone's SOA minimum, 24 hours on Route 53. Players would stay locked
      // out long after the server woke. The instance writes its real address over
      // this on boot and re-asserts it every five minutes.
      new route53.ARecord(this, 'GameRecord', {
        zone,
        target: route53.RecordTarget.fromIpAddresses(config.parkedIp),
        ttl: cdk.Duration.seconds(config.dnsTtlSeconds),
      });

      connectAddress = `${config.domainName}:${config.gamePort}`;

      // Empties the zone during teardown. Without this `cdk destroy` fails: the
      // instance rewrites the A record above with its real address on every boot,
      // CloudFormation still expects the parked value, its delete does not match,
      // and Route 53 will not remove a zone that still holds records.
      const cleanupFn = new lambda.Function(this, 'ZoneCleanupFn', {
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('lambda/zonecleanup'),
        timeout: cdk.Duration.minutes(2),
        description: 'Removes leftover records so the hosted zone can be deleted',
        environment: {
          HOSTED_ZONE_ID: zone.hostedZoneId,
          ZONE_NAME: config.domainName,
        },
      });
      cleanupFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['route53:ListResourceRecordSets', 'route53:ChangeResourceRecordSets'],
          resources: [zone.hostedZoneArn],
        }),
      );

      const cleanup = new cdk.CustomResource(this, 'ZoneCleanup', {
        serviceToken: new cr.Provider(this, 'ZoneCleanupProvider', {
          onEventHandler: cleanupFn,
        }).serviceToken,
      });
      // CloudFormation deletes dependents before their dependencies, so declaring
      // the zone as a dependency puts the cleanup ahead of the zone delete.
      cleanup.node.addDependency(zone);
    } else if (config.addressing === 'elastic-ip') {
      // No domain needed. Costs about $3.60/month, since a public IPv4 bills
      // hourly whether the instance runs or not, and buys an address that survives
      // every restart.
      elasticIp = new ec2.CfnEIP(this, 'Eip', {
        domain: 'vpc',
        tags: [{ key: 'Name', value: 'palworld' }],
      });
      connectAddress = `${elasticIp.attrPublicIp}:${config.gamePort}`;
    } else {
      // 'server-list'. Nothing gets allocated. The server registers itself in the
      // Community Servers browser at startup and advertises whichever public address
      // it happens to have, so players find it by name and a changing IP stops
      // mattering. No Elastic IP charge, no domain, no DNS to set up.
      connectAddress = `Community Servers, search for "${config.serverName}"`;
    }

    // ---- Instance scripts, shipped as an S3 asset -------------------------
    // Re-downloaded on every boot, so editing server/ and deploying takes effect at
    // the next start without replacing the instance or disturbing the save volume.
    const serverAssets = new s3assets.Asset(this, 'ServerScripts', {
      path: path.join(__dirname, '..', 'server'),
    });

    // ---- Instance role ----------------------------------------------------
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        // Attached whether or not enhanced monitoring is on, so switching it on
        // needs no IAM change and no instance restart. Also covers the Docker log
        // driver's writes.
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });

    backupBucket.grantReadWrite(role);
    backupBucket.grantDelete(role);
    serverAssets.grantRead(role);
    instanceLogs.grantWrite(role);

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Arn.format(
            { service: 'ssm', resource: 'parameter', resourceName: RUNTIME_PARAM_NAME.slice(1) },
            this,
          ),
        ],
      }),
    );

    if (zone) {
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'route53:ChangeResourceRecordSets',
            'route53:ListResourceRecordSets',
            'route53:GetChange',
          ],
          resources: [zone.hostedZoneArn, 'arn:aws:route53:::change/*'],
        }),
      );
    }

    // The instance stops itself once the server has been empty long enough. Scoped
    // by tag because the role gets created before the instance exists.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StopInstances'],
        resources: ['*'],
        conditions: { StringEquals: { 'ec2:ResourceTag/Application': 'palworld' } },
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeTags'],
        resources: ['*'],
      }),
    );

    // ---- Runtime configuration -------------------------------------------
    // Read fresh on every boot, which is why most of config.ts can change without
    // rebuilding anything.
    const runtimeConfig = new ssm.StringParameter(this, 'RuntimeConfig', {
      parameterName: RUNTIME_PARAM_NAME,
      description: 'Runtime settings read by the Palworld instance at boot',
      stringValue: JSON.stringify({
        region: this.region,
        addressing: config.addressing,
        assetUrl: serverAssets.s3ObjectUrl,
        backupBucket: backupBucket.bucketName,
        hostedZoneId: zone ? zone.hostedZoneId : '',
        recordName: usingRoute53 ? config.domainName : '',
        dnsTtl: config.dnsTtlSeconds,
        image: config.palworldImage,
        gamePort: config.gamePort,
        restApiPort: config.restApiPort,
        serverName: config.serverName,
        serverDescription: config.serverDescription,
        serverPassword: config.serverPassword,
        maxPlayers: config.maxPlayers,
        communityServer: config.communityServer.enabled,
        crossplayPlatforms: config.communityServer.crossplayPlatforms,
        swapGb: config.swapGb,
        idleShutdownMinutes: config.idleShutdownMinutes,
        backupIntervalMinutes: config.backupIntervalMinutes,
        backupsToKeep: config.backupsToKeep,
        metricNamespace: METRIC_NAMESPACE,
        playerMetricName: PLAYER_METRIC,
        backupMetricName: BACKUP_METRIC,
        healthMetricName: HEALTH_METRIC,
        enhancedMonitoring: config.enhancedMonitoring.enabled,
        instanceLogGroup: INSTANCE_LOG_GROUP,
      }),
    });

    // ---- The instance -----------------------------------------------------
    // User data only bootstraps the fetch loop. The real work is in server/,
    // because user data runs once and is baked into the launch config.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'exec > >(tee /var/log/palworld-userdata.log) 2>&1',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -y',
      'apt-get install -y curl unzip jq ca-certificates',
      // Ubuntu's packaged awscli lags behind, so take v2 from the source.
      'if ! command -v aws >/dev/null 2>&1; then',
      '  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip',
      '  unzip -q -o /tmp/awscliv2.zip -d /tmp',
      '  /tmp/aws/install --update',
      'fi',
      'mkdir -p /etc/palworld',
      `echo '${RUNTIME_PARAM_NAME}' > /etc/palworld/param-name`,
      `echo '${this.region}' > /etc/palworld/region`,
      // Fetch and run, re-executed on every boot by the unit below.
      "cat > /usr/local/bin/palworld-boot <<'PALBOOT'",
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'PARAM=$(cat /etc/palworld/param-name)',
      'REGION=$(cat /etc/palworld/region)',
      'mkdir -p /opt/palworld',
      // Temp file then rename. A plain redirect truncates the target before the
      // fetch returns, and a timer reading the config in that window sees an empty
      // file. rename is atomic, so readers get old or new.
      'aws ssm get-parameter --name "$PARAM" --region "$REGION" --query Parameter.Value --output text > /etc/palworld/config.json.new',
      'mv /etc/palworld/config.json.new /etc/palworld/config.json',
      'ASSET=$(jq -r .assetUrl /etc/palworld/config.json)',
      'rm -rf /opt/palworld/bin.new && mkdir -p /opt/palworld/bin.new',
      'aws s3 cp "$ASSET" /tmp/palworld-scripts.zip --region "$REGION"',
      'unzip -q -o /tmp/palworld-scripts.zip -d /opt/palworld/bin.new',
      // The zip loses the executable bit when built on Windows.
      'chmod +x /opt/palworld/bin.new/*.sh /opt/palworld/bin.new/*.py 2>/dev/null || true',
      // Strip carriage returns for the same reason. A single CRLF shebang fails
      // with "/usr/bin/env: bash\\r: No such file or directory" and takes the whole
      // bootstrap down, which means no game server at all on the next boot. Cheap
      // insurance for a repo that gets edited from Windows.
      "sed -i 's/\\r$//' /opt/palworld/bin.new/*.sh /opt/palworld/bin.new/*.py 2>/dev/null || true",
      'rm -rf /opt/palworld/bin.old',
      'if [ -d /opt/palworld/bin ]; then mv /opt/palworld/bin /opt/palworld/bin.old; fi',
      'mv /opt/palworld/bin.new /opt/palworld/bin',
      'exec /opt/palworld/bin/bootstrap.sh',
      'PALBOOT',
      'chmod +x /usr/local/bin/palworld-boot',
      "cat > /etc/systemd/system/palworld-boot.service <<'PALUNIT'",
      '[Unit]',
      'Description=Fetch Palworld server scripts and run bootstrap',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=oneshot',
      'RemainAfterExit=yes',
      'ExecStart=/usr/local/bin/palworld-boot',
      'TimeoutStartSec=3600',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'PALUNIT',
      'systemctl daemon-reload',
      'systemctl enable --now palworld-boot.service',
    );

    const instance = new ec2.Instance(this, 'Server', {
      vpc,
      vpcSubnets: { subnets: [subnet] },
      instanceType: new ec2.InstanceType(config.instanceType),
      // Resolved once at synth and cached in cdk.context.json. Deliberately not the
      // SSM "latest" alias, which re-resolves every deploy, so a routine Canonical
      // publish would replace your instance mid-season. Run `cdk context --clear`
      // when you want a newer one.
      machineImage: ec2.MachineImage.lookup({
        name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
        owners: ['099720109477'], // Canonical
      }),
      securityGroup,
      role,
      userData,
      requireImdsv2: true,
      // Never throttle play down to the burst baseline. See config.ts for what this
      // can add to the bill under sustained load.
      creditSpecification: ec2.CpuCredits.UNLIMITED,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(config.rootVolumeGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    instance.node.addDependency(runtimeConfig);

    new ec2.CfnVolumeAttachment(this, 'SaveDataAttachment', {
      device: '/dev/sdf',
      instanceId: instance.instanceId,
      volumeId: dataVolume.volumeId,
    });

    if (elasticIp) {
      new ec2.CfnEIPAssociation(this, 'EipAssociation', {
        allocationId: elasticIp.attrAllocationId,
        instanceId: instance.instanceId,
      });
    }

    // ---- Cost backstop ----------------------------------------------------
    // The instance normally stops itself, gracefully, after idleShutdownMinutes
    // with nobody on. This catches the case where that never happens, which would
    // otherwise bill around the clock.
    //
    // Deliberately not a CloudWatch alarm with an EC2 stop action. That needs no
    // Lambda and looks cheaper, but an alarm cannot tell "instance stopped, so no
    // metrics" apart from "instance running and reporting nothing". Set
    // treatMissingData to BREACHING and it enters ALARM the moment it is created
    // and never leaves. An early version of this stack killed its instance 25
    // seconds into the first boot that way. Reading instance state first fixes it.
    const watchdog = new lambda.Function(this, 'IdleWatchdog', {
      functionName: config.watchdogFunctionName,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/backstop'),
      timeout: cdk.Duration.seconds(60),
      memorySize: 128,
      description: 'Stops the Palworld instance if the on-instance idle check has failed',
      environment: {
        TARGET_REGION: this.region,
        METRIC_NAMESPACE,
        METRIC_NAME: PLAYER_METRIC,
        HARD_STOP_MINUTES: String(config.hardStopMinutes),
        BOOT_GRACE_MINUTES: String(config.bootGraceMinutes),
      },
      logGroup: new logs.LogGroup(this, 'IdleWatchdogLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    watchdog.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances', 'cloudwatch:GetMetricStatistics'],
        resources: ['*'], // Neither action supports resource-level scoping.
      }),
    );
    watchdog.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StopInstances'],
        resources: ['*'],
        conditions: { StringEquals: { 'ec2:ResourceTag/Application': 'palworld' } },
      }),
    );

    new events.Rule(this, 'IdleWatchdogSchedule', {
      description: 'Periodic check that the Palworld server is not running unattended',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(watchdog)],
    });

    // ---- Start page -------------------------------------------------------
    // Nothing wakes the server on its own in elastic-ip mode, so this gives you a
    // link that does.
    let startPageUrl: string | undefined;
    if (config.startPage.enabled) {
      const startPage = new lambda.Function(this, 'StartPage', {
        functionName: config.startPageFunctionName,
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'index.handler',
        code: lambda.Code.fromAsset('lambda/startpage'),
        timeout: cdk.Duration.seconds(30),
        memorySize: 128,
        description: 'Web page with a button that starts the Palworld server',
        environment: {
          TARGET_REGION: this.region,
          ACCESS_TOKEN: config.startPage.token,
          CONNECT_ADDRESS: connectAddress,
          SERVER_NAME: config.serverName,
          SERVER_PASSWORD: config.serverPassword,
          IDLE_MINUTES: String(config.idleShutdownMinutes),
          BOOT_GRACE_MINUTES: String(config.bootGraceMinutes),
          METRIC_NAMESPACE,
          METRIC_NAME: PLAYER_METRIC,
        },
        logGroup: new logs.LogGroup(this, 'StartPageLogs', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      });

      // The player metric is how the page tells "the box is on" apart from "the
      // game is answering", which are minutes apart on every boot.
      startPage.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ec2:DescribeInstances', 'cloudwatch:GetMetricStatistics'],
          resources: ['*'], // Neither action supports resource-level scoping.
        }),
      );
      startPage.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ec2:StartInstances'],
          resources: ['*'],
          conditions: { StringEquals: { 'ec2:ResourceTag/Application': 'palworld' } },
        }),
      );

      // No IAM auth, because a browser cannot sign requests without extra tooling.
      // The token in the query string is what guards it. Someone with the link can
      // start your server and nothing else, which costs one idle timeout.
      const url = startPage.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
      startPageUrl = `${url.url}?t=${config.startPage.token}`;
    }

    // ---- Dashboard --------------------------------------------------------
    if (config.dashboard.enabled) {
      const dashboard = new PalworldDashboard(this, 'Dashboard', {
        dashboardName: config.dashboard.name,
        instanceId: instance.instanceId,
        dataVolumeId: dataVolume.volumeId,
        backupBucketName: backupBucket.bucketName,
        serverRegion: this.region,
        wakeRegion: config.dnsRegion,
        wakeFunctionName: usingRoute53 ? config.wakeFunctionName : undefined,
        watchdogFunctionName: config.watchdogFunctionName,
        metricNamespace: METRIC_NAMESPACE,
        playerMetricName: PLAYER_METRIC,
        backupMetricName: BACKUP_METRIC,
        healthMetricName: HEALTH_METRIC,
        connectAddress,
        serverName: config.serverName,
        serverPassword: config.serverPassword,
        idleShutdownMinutes: config.idleShutdownMinutes,
        showMemory: config.enhancedMonitoring.enabled,
        memoryMetricName: MEMORY_METRIC,
        swapMetricName: SWAP_METRIC,
        diskMetricName: DISK_METRIC,
      });

      new cdk.CfnOutput(this, 'DashboardUrl', {
        value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards/dashboard/${dashboard.dashboardName}`,
        description: 'CloudWatch dashboard for the server',
      });
    }

    this.instanceId = instance.instanceId;
    this.dataVolumeId = dataVolume.volumeId;
    this.backupBucketName = backupBucket.bucketName;

    // ---- Outputs ----------------------------------------------------------
    new cdk.CfnOutput(this, 'ConnectAddress', {
      value: connectAddress,
      description:
        'How players reach the server. An address goes in the Join Multiplayer Game field, port included; otherwise search the Community Servers browser for the name.',
    });
    new cdk.CfnOutput(this, 'ConnectServerName', {
      value: config.serverName,
      description: 'Server name shown in game',
    });
    new cdk.CfnOutput(this, 'ConnectPassword', {
      value: config.serverPassword || '(no password)',
      description: 'Password players enter when joining',
    });
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'BackupBucket', { value: backupBucket.bucketName });
    new cdk.CfnOutput(this, 'Addressing', { value: config.addressing });

    if (zone) {
      new cdk.CfnOutput(this, 'HostedZoneId', { value: zone.hostedZoneId });
      new cdk.CfnOutput(this, 'DomainName', { value: config.domainName });
      new cdk.CfnOutput(this, 'ApexDomain', { value: config.apexDomain });
      new cdk.CfnOutput(this, 'NameServers', {
        value: cdk.Fn.join(',', zone.hostedZoneNameServers ?? []),
        description: 'NS records to publish at your registrar for the subdomain',
      });
    }
    if (startPageUrl) {
      new cdk.CfnOutput(this, 'StartPageUrl', {
        value: startPageUrl,
        description: 'Private link that starts the server. Treat it like a password.',
      });
    }
  }
}
