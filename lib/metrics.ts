/**
 * Names shared by the stacks, the dashboard, and the scripts on the instance.
 *
 * Kept in their own module so the dashboard and the alarm definitions can both
 * reference them without importing the server stack, which imports the dashboard.
 */

export const RUNTIME_PARAM_NAME = '/palworld/runtime-config';
export const INSTANCE_LOG_GROUP = '/palworld/instance';

export const METRIC_NAMESPACE = 'Palworld';

/** Published every minute by idle-check.sh on the instance. */
export const PLAYER_METRIC = 'PlayersOnline';
/** Published by backup.sh after every successful upload. */
export const BACKUP_METRIC = 'BackupSucceeded';
/**
 * 1 when the game's own REST API answers, 0 when it does not.
 *
 * The publisher is a systemd timer that runs whether or not the game is up, which is
 * what makes the zero meaningful rather than merely absent. Three states then become
 * distinguishable: no datapoint is a stopped instance, 0 is a running box with a dead
 * or still-booting game, and 1 is joinable.
 */
export const HEALTH_METRIC = 'GameServerUp';

/** The three below come from the CloudWatch agent, so they only exist when
 * enhanced monitoring is switched on. */
export const MEMORY_METRIC = 'MemoryUsedPercent';
export const SWAP_METRIC = 'SwapUsedPercent';
export const DISK_METRIC = 'DiskUsedPercent';
