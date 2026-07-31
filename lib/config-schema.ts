/**
 * Shape of a config file. Both lib/config.ts (the template) and any private copy
 * you keep out of git have to satisfy this, so a typo or a missing field fails at
 * synth instead of halfway through a deploy.
 *
 * The prose explaining what each field does lives in lib/config.ts.
 */

export type Addressing = 'server-list' | 'elastic-ip' | 'route53';

export interface CommunityServerConfig {
  readonly enabled: boolean;
  readonly queryPort: number;
  readonly crossplayPlatforms: string;
}

export interface StartPageConfig {
  readonly enabled: boolean;
  readonly token: string;
}

export interface DashboardConfig {
  readonly enabled: boolean;
  readonly name: string;
}

export interface EnhancedMonitoringConfig {
  readonly enabled: boolean;
  readonly alertEmail: string;
  readonly memoryAlarmPercent: number;
  readonly swapAlarmPercent: number;
  readonly diskAlarmPercent: number;
  readonly logRetentionDays: number;
}

export interface PalworldConfig {
  readonly account: string;
  readonly region: string;
  readonly dnsRegion: string;

  readonly addressing: Addressing;
  readonly domainName: string;
  readonly apexDomain: string;
  readonly dnsTtlSeconds: number;
  readonly parkedIp: string;

  readonly instanceType: string;
  readonly rootVolumeGb: number;
  readonly dataVolumeGb: number;
  readonly swapGb: number;

  readonly palworldImage: string;
  readonly gamePort: number;
  readonly restApiPort: number;
  readonly serverName: string;
  readonly serverDescription: string;
  readonly serverPassword: string;
  readonly maxPlayers: number;
  readonly communityServer: CommunityServerConfig;

  readonly idleShutdownMinutes: number;
  readonly hardStopMinutes: number;
  readonly bootGraceMinutes: number;

  readonly startPage: StartPageConfig;

  readonly backupIntervalMinutes: number;
  readonly backupsToKeep: number;
  readonly backupExpiryDays: number;

  readonly dashboard: DashboardConfig;
  readonly enhancedMonitoring: EnhancedMonitoringConfig;

  readonly wakeFunctionName: string;
  readonly watchdogFunctionName: string;
  readonly startPageFunctionName: string;
}
