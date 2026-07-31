#!/usr/bin/env bash
# Shared paths, config accessors, and instance metadata helpers.
# Sourced by every other script in this directory.

CONFIG_FILE=/etc/palworld/config.json
INSTALL_DIR=/opt/palworld
BIN_DIR="$INSTALL_DIR/bin"
DATA_DIR="$INSTALL_DIR/data"
SAVED_DIR="$DATA_DIR/Saved"
ADMIN_PW_FILE="$DATA_DIR/admin_password"
IDLE_STATE_FILE=/run/palworld-idle-minutes

# palworld-boot rewrites the config at every boot. A timer firing inside that
# window would read a half-written file and fail deep inside some jq invocation
# with a useless message, so refuse early and clearly instead.
if [ ! -s "$CONFIG_FILE" ] || ! jq -e . "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "[palworld] $CONFIG_FILE missing or incomplete; bootstrap has not finished yet" >&2
  exit 0
fi

# Read a value out of the runtime config published by CDK to SSM.
cfg() { jq -r "$1 // empty" "$CONFIG_FILE"; }

REGION=$(cfg .region)
ADDRESSING=$(cfg .addressing)
BACKUP_BUCKET=$(cfg .backupBucket)
HOSTED_ZONE_ID=$(cfg .hostedZoneId)
RECORD_NAME=$(cfg .recordName)
DNS_TTL=$(cfg .dnsTtl)
PALWORLD_IMAGE=$(cfg .image)
GAME_PORT=$(cfg .gamePort)
REST_PORT=$(cfg .restApiPort)
SERVER_NAME=$(cfg .serverName)
SERVER_DESCRIPTION=$(cfg .serverDescription)
SERVER_PASSWORD=$(cfg .serverPassword)
MAX_PLAYERS=$(cfg .maxPlayers)
COMMUNITY_SERVER=$(cfg .communityServer)
CROSSPLAY_PLATFORMS=$(cfg .crossplayPlatforms)
SWAP_GB=$(cfg .swapGb)
IDLE_SHUTDOWN_MINUTES=$(cfg .idleShutdownMinutes)
BACKUP_INTERVAL_MINUTES=$(cfg .backupIntervalMinutes)
BACKUPS_TO_KEEP=$(cfg .backupsToKeep)
METRIC_NAMESPACE=$(cfg .metricNamespace)
PLAYER_METRIC_NAME=$(cfg .playerMetricName)
BACKUP_METRIC_NAME=$(cfg .backupMetricName)
HEALTH_METRIC_NAME=$(cfg .healthMetricName)
ENHANCED_MONITORING=$(cfg .enhancedMonitoring)
INSTANCE_LOG_GROUP=$(cfg .instanceLogGroup)

export AWS_DEFAULT_REGION="$REGION"

# Goes to stdout, which systemd captures into journald, and to a file so the
# CloudWatch agent can ship it when enhanced monitoring is on. journald alone is
# unreadable while the instance is stopped, which is often exactly when you want it.
log() {
  local line="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$line"
  echo "$line" >> /var/log/palworld.log 2>/dev/null || true
}

# IMDSv2 is enforced on this instance, so every metadata read needs a token.
imds() {
  local token
  token=$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300" --max-time 5) || return 1
  curl -sS -H "X-aws-ec2-metadata-token: $token" \
    "http://169.254.169.254/latest/meta-data/$1" --max-time 5
}

instance_id() { imds instance-id; }
public_ip() { imds public-ipv4; }

admin_password() { cat "$ADMIN_PW_FILE" 2>/dev/null; }
