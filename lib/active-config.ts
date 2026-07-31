import * as path from 'path';
import { config as template } from './config';
import { PalworldConfig } from './config-schema';

/**
 * Resolves which config the app deploys with.
 *
 * By default that is lib/config.ts, the committed template. Point
 * PALWORLD_CONFIG at another file in your .env to keep real values out of git:
 *
 *   PALWORLD_CONFIG=lib/config.local.ts
 *
 * Everything else imports config from here rather than from ./config, so the
 * override applies everywhere.
 */
function resolveConfig(): PalworldConfig {
  const override = process.env.PALWORLD_CONFIG;
  if (!override) {
    return withResolvedAccount(template);
  }

  const file = path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);

  let loaded: { config?: PalworldConfig };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require(file);
  } catch (error) {
    throw new Error(
      `PALWORLD_CONFIG points at "${override}", which could not be loaded from ${file}: ${error}`,
    );
  }

  if (!loaded.config) {
    throw new Error(`${override} must export a const named "config"`);
  }

  return withResolvedAccount(loaded.config);
}

/**
 * An empty `account` means "whichever account my credentials belong to". The CDK
 * CLI resolves that and hands it over as CDK_DEFAULT_ACCOUNT.
 *
 * Filling it in is still worth doing. With an explicit account the CLI refuses to
 * deploy when your current credentials point somewhere else, which is a useful
 * guard if you have both a personal and a work account on the same machine.
 */
function withResolvedAccount(source: PalworldConfig): PalworldConfig {
  if (source.account) {
    return source;
  }
  return { ...source, account: process.env.CDK_DEFAULT_ACCOUNT ?? '' };
}

export const config: PalworldConfig = resolveConfig();

/**
 * Catches the case where someone deploys the template untouched. The placeholders
 * would otherwise reach CloudFormation and fail with something far less obvious.
 */
export function assertConfigured(): void {
  const problems: string[] = [];

  if (!config.account) {
    problems.push(
      'account is empty and no AWS credentials could be resolved. Either run `aws configure`, ' +
        'set AWS_PROFILE, put keys in .env, or hardcode the 12-digit ID in your config',
    );
  } else if (!/^\d{12}$/.test(config.account)) {
    problems.push(`account must be a 12-digit AWS account ID, got "${config.account}"`);
  }
  if (config.serverName.startsWith('<')) {
    problems.push('serverName still holds its placeholder');
  }
  if (config.serverPassword.startsWith('<')) {
    problems.push('serverPassword still holds its placeholder (use an empty string for no password)');
  }
  if (config.addressing === 'server-list' && !config.communityServer.enabled) {
    problems.push(
      'addressing is "server-list" but communityServer.enabled is false, so the server ' +
        'gets no address and never appears in the browser. Nobody could reach it.',
    );
  }
  if (config.addressing === 'route53') {
    if (config.domainName.startsWith('<')) {
      problems.push('addressing is "route53" but domainName still holds its placeholder');
    }
    if (config.apexDomain.startsWith('<')) {
      problems.push('addressing is "route53" but apexDomain still holds its placeholder');
    }
  }
  if (config.startPage.enabled && config.startPage.token.startsWith('<')) {
    problems.push('startPage.enabled is true but token still holds its placeholder');
  }
  if (config.hardStopMinutes <= config.idleShutdownMinutes) {
    problems.push(
      `hardStopMinutes (${config.hardStopMinutes}) must exceed idleShutdownMinutes ` +
        `(${config.idleShutdownMinutes}), or the blunt stop beats the graceful one and you lose the final save`,
    );
  }
  if (config.enhancedMonitoring.enabled && config.enhancedMonitoring.alertEmail.startsWith('<')) {
    problems.push('enhancedMonitoring.alertEmail still holds its placeholder (use an empty string for no email)');
  }

  if (problems.length > 0) {
    throw new Error(
      ['Config is not ready to deploy:', ...problems.map((p) => `  - ${p}`)].join('\n'),
    );
  }
}
