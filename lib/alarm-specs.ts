import { config } from './active-config';
import { DISK_METRIC, MEMORY_METRIC, SWAP_METRIC } from './metrics';

/**
 * One definition of each resource alarm, used to build the alarm itself and to draw
 * the matching threshold line on the dashboard.
 *
 * Shared deliberately. With the threshold in the monitoring stack and the line in
 * the dashboard, changing one would leave the chart quietly lying about when the
 * alarm fires.
 */
export interface ResourceAlarmSpec {
  /** Construct id, which also ends up in the alarm name. */
  readonly id: string;
  readonly metricName: string;
  /** Percent. Breaching means strictly above this. */
  readonly threshold: number;
  /** How many periods CloudWatch looks back over. */
  readonly evaluationPeriods: number;
  /** How many of those have to breach. Equal to evaluationPeriods means sustained. */
  readonly datapointsToAlarm: number;
  readonly periodMinutes: number;
  readonly title: string;
  readonly rationale: string;
}

export function resourceAlarmSpecs(): ResourceAlarmSpec[] {
  const settings = config.enhancedMonitoring;

  return [
    {
      id: 'MemoryHigh',
      metricName: MEMORY_METRIC,
      threshold: settings.memoryAlarmPercent,
      evaluationPeriods: 10,
      datapointsToAlarm: 10,
      periodMinutes: 1,
      title: 'Memory',
      rationale: 'Your only warning before an out-of-memory kill. Consider a larger instanceType.',
    },
    {
      id: 'SwapHigh',
      metricName: SWAP_METRIC,
      threshold: settings.swapAlarmPercent,
      evaluationPeriods: 15,
      datapointsToAlarm: 15,
      periodMinutes: 1,
      title: 'Swap',
      rationale: 'Steady swap use means the server has outgrown its RAM and players feel it as stutter.',
    },
    {
      id: 'DiskHigh',
      metricName: DISK_METRIC,
      threshold: settings.diskAlarmPercent,
      evaluationPeriods: 5,
      datapointsToAlarm: 5,
      periodMinutes: 1,
      title: 'Root disk',
      rationale: 'The container image and swap file leave less headroom than you might expect.',
    },
  ];
}

/**
 * The caption printed on the dashboard's threshold line, so you can read the alarm
 * condition off the chart instead of hunting for it in the console.
 */
export function alarmCaption(spec: ResourceAlarmSpec): string {
  const window = spec.evaluationPeriods * spec.periodMinutes;
  return (
    `Alarm above ${spec.threshold}% ` +
    `(${spec.datapointsToAlarm} of ${spec.evaluationPeriods} datapoints, ${window} min)`
  );
}

/**
 * The alarms that fire on an occurrence rather than a level. Drawing a line at zero
 * would tell you nothing, so their condition goes in the chart title instead.
 *
 * Shared with the monitoring stack for the same reason as the specs above.
 */
export const EVENT_ALARMS = {
  statusCheck: { evaluationPeriods: 3, datapointsToAlarm: 3, periodMinutes: 1 },
  lambdaErrors: { evaluationPeriods: 2, datapointsToAlarm: 2, periodMinutes: 5 },
  unresponsive: { evaluationPeriods: 6, datapointsToAlarm: 6, periodMinutes: 5 },
  backupsStalled: { evaluationPeriods: 10, datapointsToAlarm: 10, periodMinutes: 5 },
} as const;

export interface EventAlarm {
  readonly evaluationPeriods: number;
  readonly datapointsToAlarm: number;
  readonly periodMinutes: number;
}

/** e.g. "alarm on any error, 2 of 2 datapoints, 10 min" */
export function eventCaption(alarm: EventAlarm, condition: string): string {
  const window = alarm.evaluationPeriods * alarm.periodMinutes;
  return `alarm ${condition}, ${alarm.datapointsToAlarm} of ${alarm.evaluationPeriods} datapoints, ${window} min`;
}
