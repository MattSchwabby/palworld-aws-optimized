/**
 * Every setting for the server lives here. Copy this file, fill in the
 * <PLACEHOLDER> values, and you have a deployable server.
 *
 * Anything marked "read at boot" is published to SSM Parameter Store and re-read by
 * the instance each time it starts, so changing it needs a deploy and a restart
 * rather than a rebuild. Run `scripts/apply-config.sh` to pick up changes on a
 * server that is already running.
 *
 * To keep your real settings out of git, copy this to `lib/config.local.ts` and set
 * `PALWORLD_CONFIG=lib/config.local.ts` in `.env`. See lib/active-config.ts.
 */

import { PalworldConfig } from './config-schema';

/**
 * How players reach the server. Three options:
 *
 * 'server-list':
 * The server registers itself in Palworld's Community Servers browser and players
 * find it by searching `serverName`. Nothing is allocated, so there is no address to
 * pay for and no DNS to configure, and a changing public IP stops mattering because
 * the server re-advertises itself on every start. This is the only mode consoles can
 * use without help, since PS5 and Xbox have no field for typing an address.
 *
 * Waking is manual: a one-click web page (see `startPage`), or `scripts/start.sh`.
 *
 * 'elastic-ip':
 * A numeric address that never changes, for a private group who would rather type an
 * address than appear in a public browser. Costs about $3.60/month, because a public
 * IPv4 bills at $0.005/hour whether the instance runs or not.
 *
 * Waking is manual, as above.
 *
 * 'route53':
 * A subdomain delegated to Route 53. Unlocks wake-on-connect, where the DNS lookup
 * a player's game makes before connecting is what starts the server. Drops the
 * always-on IP charge, since the instance updates its own record on boot and only
 * pays for a public IPv4 while running.
 *
 * You need a domain you control, and you have to point NS records for one
 * subdomain at Route 53. Wake-on-connect only helps PC players.
 */
export const config: PalworldConfig = {
  // ---- AWS placement -------------------------------------------------------
  /**
   * 12-digit AWS account ID to deploy into. Leave it as an empty string and the
   * account behind your current credentials is used instead.
   *
   * Filling it in is worth the two seconds. With an explicit account the CDK CLI
   * refuses to deploy when your credentials point somewhere else, which saves you
   * if you have a work account and a personal one on the same machine.
   */
  account: '',
  /** Where the game server runs. Pick something close to your players. */
  region: 'us-west-2',
  /**
   * Route 53 query logging can only write to CloudWatch Logs in us-east-1, so the
   * wake-on-connect plumbing is pinned there. Ignored unless addressing is
   * 'route53'. The Lambda still starts an instance in `region` above.
   */
  dnsRegion: 'us-east-1',

  // ---- How players connect -------------------------------------------------
  /**
   * 'server-list' is the default because it costs nothing extra, needs no domain and
   * no DNS setup, and is the one mode console players can reach on their own.
   * Switch to 'route53' if you own a domain and want the server to wake up by itself
   * when someone tries to join.
   */
  addressing: 'server-list',

  /**
   * Required when addressing is 'route53'. The subdomain players connect to, which
   * gets its own hosted zone and needs NS records at your registrar.
   *
   * Leave as-is for 'server-list' and 'elastic-ip'.
   */
  domainName: '<palworld.yourdomain.com>',
  /**
   * Apex domain at your registrar, used only by scripts/sync-cloudflare-ns.sh to
   * write the delegation for you. Ignored if you set up NS records by hand.
   */
  apexDomain: '<yourdomain.com>',
  /**
   * Short, so players pick up a new address quickly after a restart. Also keeps
   * lookups reaching Route 53 rather than being served from a resolver cache, which
   * is what wake-on-connect depends on.
   */
  dnsTtlSeconds: 30,
  /**
   * What the record holds while the server sleeps. An absent record answers
   * NXDOMAIN, and resolvers cache that for the zone's SOA minimum, which Route 53
   * sets to 24 hours by default. Players would stay locked out long after the
   * server came back. 203.0.113.1 is TEST-NET-3 from RFC 5737 and routes nowhere.
   */
  parkedIp: '203.0.113.1',

  // ---- Compute -------------------------------------------------------------
  /**
   * t3.medium is the cheapest 4 GB x86 option, around $0.0416/hour.
   *
   * Be aware that 4 GB sits below what Pocketpair ask for. They say 8 GB "is also
   * bootable, but increases the possibility of server crashes due to out of
   * memory", and an out-of-memory kill can corrupt a save. A swap file and frequent
   * backups soften that, and enhanced monitoring will warn you before it happens.
   * If the server stutters with several players on, m6i.large (8 GB) is the next
   * step up, and m6i.xlarge (4 vCPU, 16 GB) matches the official recommendation.
   * Changing this restarts the instance but leaves your world alone.
   *
   * t3 instances burst. Credits are set to unlimited so play never gets throttled,
   * which means sustained CPU above the baseline adds $0.05 per vCPU-hour. For
   * predictable billing instead, use c6a.large.
   */
  instanceType: 't3.medium',
  /**
   * Root volume. Measured usage on a running server is about 20 GB: 7.3 GB of
   * unpacked container image, the 4 GB swap file below, and roughly 8 GB of Ubuntu
   * and logs. The bootstrap deletes the previous image version before pulling a new
   * one, so a game update never needs room for two at once.
   *
   * Raising this replaces the instance, since block device mappings are immutable.
   * Your world is on the other volume and is not affected.
   */
  rootVolumeGb: 30,
  /**
   * Save data gets its own volume, retained when the stack is destroyed.
   *
   * A fresh world is under a megabyte. Saves grow with world size and base count,
   * and Palworld keeps its own local backups, so a long-lived server might reach a
   * few GB. Four is roomy. EBS volumes grow online but never shrink, so start small
   * and raise this if the disk alarm ever fires.
   */
  dataVolumeGb: 4,
  /**
   * Swap file on the root volume. Your protection against an out-of-memory kill.
   *
   * Four alongside 4 GB of RAM gives the server 8 GB to address, which is the floor
   * Pocketpair call bootable. Going higher eats root disk you do not have much of:
   * the image and the OS already take roughly 16 GB of 30, so an 8 GB swapfile puts
   * the volume near 85 percent full. Raise this and rootVolumeGb together.
   *
   * Changing it rebuilds the file on the next boot, since a swapfile cannot be
   * resized in place.
   */
  swapGb: 4,

  // ---- Game ----------------------------------------------------------------
  /**
   * Official Pocketpair image. Tags follow game versions, listed at
   * https://github.com/pocketpairjp/palworld-dedicated-server-docker/pkgs/container/palserver
   *
   * Pin a version rather than tracking latest, so a game update never surprises a
   * world you care about. Back up before you bump it.
   */
  palworldImage: 'ghcr.io/pocketpairjp/palserver:v1.0.2.101103',
  gamePort: 8211,
  /** Palworld's local REST API, bound to 127.0.0.1 and never exposed. */
  restApiPort: 8212,
  /** Read at boot. Shown to players in the game. */
  serverName: '<Your Server Name>',
  serverDescription: 'Sleeps when empty. The first join attempt wakes it up, so wait two minutes and try again.',
  /**
   * Read at boot. Empty string means anyone who knows the address can join. This
   * ends up committed to your repo, so treat it as a speed bump rather than a
   * secret.
   */
  serverPassword: '<serverpassword>',
  /** Read at boot. Keep this low on 4 GB. */
  maxPlayers: 8,
  /**
   * Register in the in-game Community Servers browser.
   *
   * Turn this on if anyone plays on PS5 or Xbox. Consoles have no field for typing
   * an address, so the browser is the only way they can reach your server, and a
   * server that has not registered simply does not exist to them. Players find it
   * by searching the exact `serverName`, so make that distinctive.
   *
   * Adds the -publiclobby startup flag. The public address is detected
   * automatically, so a changing IP is not a problem.
   *
   * Being listed means anyone can see the server exists. `serverPassword` is what
   * stops them joining, so set one if you enable this.
   *
   * Read at boot.
   */
  communityServer: {
    enabled: true,
    /**
     * Steam-style query port, opened alongside the game port when enabled.
     * Pocketpair's own docs never mention it, but every hosting guide says the
     * browser listing needs it, and an extra UDP port on a game server costs
     * nothing. Set to 0 to skip opening it.
     */
    queryPort: 27015,
    /**
     * Who may connect. This is the shipped default, set explicitly so a future
     * change to that default cannot silently lock out your console players.
     */
    crossplayPlatforms: 'Steam,Xbox,PS5,Mac',
  },

  // ---- Cost control --------------------------------------------------------
  /**
   * Read at boot. Minutes with nobody connected before the server saves, backs up,
   * and stops the instance. Your single biggest lever on the bill.
   *
   * Going too short risks shutting down while somebody reconnects after a drop,
   * which sends them through the two-minute wake again.
   */
  idleShutdownMinutes: 20,
  /**
   * A Lambda stops the instance after this many minutes of the player count reading
   * zero or going missing, which is what a wedged agent looks like. Keep it well
   * above idleShutdownMinutes so the graceful shutdown always gets there first.
   */
  hardStopMinutes: 35,
  /**
   * How long a freshly started instance is left alone. A cold boot installs Docker
   * and pulls a large image before the game can report anything, so this needs
   * room. An early version of this stack killed its own instance 25 seconds into
   * the first boot.
   */
  bootGraceMinutes: 25,

  // ---- Waking the server ---------------------------------------------------
  /**
   * A small web page with a start button, served by a Lambda Function URL. On
   * 'server-list' and 'elastic-ip' it is the only thing that wakes the server. Keep
   * it on with 'route53' too: wake-on-connect covers PC players only, and a console
   * player cannot trigger a wake from inside the game, so the link is their one way
   * in.
   *
   * The URL includes a random token and is not guessable, though it needs no login.
   * Anyone holding the link can start your server, and the worst they can do is
   * cost you one idle timeout of compute. Set `token` to something long.
   */
  startPage: {
    enabled: true,
    /** Any hard-to-guess string. Becomes part of the URL. */
    token: '<random-url-token>',
  },

  // ---- Backups -------------------------------------------------------------
  /** Read at boot. */
  backupIntervalMinutes: 15,
  /** Read at boot. Timestamped archives kept in S3. Older ones get pruned. */
  backupsToKeep: 20,
  /** S3 lifecycle rule, in case the on-instance pruner ever stops working. */
  backupExpiryDays: 30,

  // ---- Monitoring ----------------------------------------------------------
  /**
   * CloudWatch gives you three custom dashboards free, and this is one of them. It
   * only graphs metrics that already exist, so it adds nothing to the bill. Sharing
   * a dashboard publicly does start billing GetMetricData calls.
   */
  dashboard: {
    enabled: true,
    name: 'Palworld',
  },
  /**
   * Deploys a separate stack that installs the CloudWatch agent, ships server logs
   * to CloudWatch, and alarms on the things that actually break.
   *
   * Off by default because it costs roughly $2/month: custom metrics are $0.30 each
   * per month, alarms $0.10 each, and log ingestion $0.50/GB. Worth turning on if
   * you run 4 GB, since a memory alarm is your only warning before an
   * out-of-memory kill corrupts a save.
   */
  enhancedMonitoring: {
    enabled: false,
    /**
     * Where alarms go. Leave empty to create the alarms without notifications and
     * watch them in the console. AWS sends a confirmation link you have to click.
     */
    alertEmail: '',
    /** Percent of RAM in use that counts as trouble. */
    memoryAlarmPercent: 85,
    /** Percent of swap in use that means the server is thrashing. */
    swapAlarmPercent: 50,
    /** Percent of the root volume in use that counts as trouble. */
    diskAlarmPercent: 85,
    /** How long to keep instance logs in CloudWatch. */
    logRetentionDays: 14,
  },

  /**
   * Fixed Lambda names, so the dashboard can point at functions in another region
   * without threading tokens across stacks. Change them if they collide with
   * something you already run.
   */
  wakeFunctionName: 'palworld-wake',
  watchdogFunctionName: 'palworld-idle-watchdog',
  startPageFunctionName: 'palworld-start-page',
};
