#!/usr/bin/env bash
# Runs on every boot, via palworld-boot.service, after the latest copy of this
# directory has been pulled from S3. Everything here is idempotent.
set -euo pipefail

source /opt/palworld/bin/lib.sh

exec > >(tee -a /var/log/palworld-bootstrap.log) 2>&1

# Without this, `set -e` aborts silently and the log just stops mid-run with no
# indication of where or why.
trap 'log "FAILED at line ${LINENO}: ${BASH_COMMAND}"' ERR

log "=== bootstrap starting ==="

# ---- Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing docker"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
fi
systemctl enable --now docker

# ---- Swap -------------------------------------------------------------------
# The whole point of this on a 4 GB box: Palworld overshooting RAM should mean a
# slow server, not an OOM kill. Pocketpair specifically warn that low memory
# corrupts saves, and a corrupted save replicates cleanly onto EBS and into every
# subsequent backup.
SWAP_FILE=/swapfile
SWAP_WANT_BYTES=$((SWAP_GB * 1024 * 1024 * 1024))
SWAP_HAVE_BYTES=0
[ -f "$SWAP_FILE" ] && SWAP_HAVE_BYTES=$(stat -c %s "$SWAP_FILE")

if [ "$SWAP_HAVE_BYTES" -ne "$SWAP_WANT_BYTES" ]; then
  if [ "$SWAP_HAVE_BYTES" -gt 0 ]; then
    # Changing swapGb has to rebuild the file, since a swapfile cannot be resized
    # in place. Safe at this point in the boot: the game has not started, so
    # nothing meaningful is paged out and swapoff has little to fault back into
    # RAM. Doing this on a busy server could trigger the OOM kill it exists to
    # prevent.
    log "resizing swap from $((SWAP_HAVE_BYTES / 1024 / 1024 / 1024))G to ${SWAP_GB}G"
    swapoff "$SWAP_FILE" 2>/dev/null || true
    rm -f "$SWAP_FILE"
  else
    log "creating ${SWAP_GB}G swap file"
  fi
  fallocate -l "${SWAP_GB}G" "$SWAP_FILE" \
    || dd if=/dev/zero of="$SWAP_FILE" bs=1M count=$((SWAP_GB * 1024)) status=none
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE" >/dev/null
fi
swapon --show=NAME --noheadings 2>/dev/null | grep -qx "$SWAP_FILE" || swapon "$SWAP_FILE"
grep -q "^${SWAP_FILE} " /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
# Keep swap as a safety net rather than something the kernel reaches for eagerly;
# paging out an active game server costs noticeable latency.
sysctl -w vm.swappiness=10 >/dev/null

# ---- Save-data volume -------------------------------------------------------
# On Nitro instances the /dev/sdf name given at attach time is only a hint — the
# kernel exposes NVMe names — and the attachment can lag the boot by a few
# seconds. Resolve by filesystem label once formatted, and fall back to "the disk
# that isn't the root disk" on the very first boot.
find_data_device() {
  if blkid -L palworld 2>/dev/null; then return 0; fi
  if [ -b /dev/sdf ]; then readlink -f /dev/sdf; return 0; fi

  local root_source root_disk name type
  root_source=$(findmnt -no SOURCE /)
  root_disk=$(lsblk -ndo PKNAME "$root_source" 2>/dev/null || true)

  while read -r name type; do
    [ "$type" = "disk" ] || continue
    [ "$name" = "$root_disk" ] && continue
    echo "/dev/$name"
    return 0
  done < <(lsblk -ndo NAME,TYPE)

  return 1
}

DATA_DEVICE=""
for _ in $(seq 1 30); do
  if DATA_DEVICE=$(find_data_device) && [ -n "$DATA_DEVICE" ]; then break; fi
  sleep 2
done

if [ -z "$DATA_DEVICE" ]; then
  log "FATAL: the save-data volume never appeared; refusing to start with no persistence"
  exit 1
fi

if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then
  log "formatting $DATA_DEVICE (first boot only)"
  mkfs.ext4 -L palworld -m 0 "$DATA_DEVICE" >/dev/null
fi

mkdir -p "$DATA_DIR"
# nofail so a volume problem degrades to a failed boot of this unit rather than
# dropping the whole instance into emergency mode where SSM cannot reach it.
grep -q "LABEL=palworld" /etc/fstab || echo "LABEL=palworld $DATA_DIR ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q "$DATA_DIR" || mount "$DATA_DIR"
log "save volume mounted: $(findmnt -no SOURCE,SIZE "$DATA_DIR")"

# ---- Restore ----------------------------------------------------------------
# Only ever fires when the volume is genuinely empty: a brand new volume, or one
# that had to be recreated. A populated volume is always authoritative.
if [ -z "$(ls -A "$SAVED_DIR" 2>/dev/null || true)" ]; then
  # `aws s3 ls` exits 1 when the prefix holds no objects, which under `set -e`
  # plus `pipefail` would abort the whole bootstrap — on every first boot, when
  # there are legitimately no backups yet.
  listing=$(aws s3 ls "s3://$BACKUP_BUCKET/saves/" 2>/dev/null || true)
  latest=$(printf '%s\n' "$listing" | awk '{print $4}' | sort | tail -1)
  if [ -n "$latest" ]; then
    log "save volume is empty; restoring from backup $latest"
    aws s3 cp "s3://$BACKUP_BUCKET/saves/$latest" /tmp/restore.tar.gz
    tar -xzf /tmp/restore.tar.gz -C "$DATA_DIR"
    rm -f /tmp/restore.tar.gz
  else
    log "no existing save and no backups: a new world will be generated"
  fi
fi
mkdir -p "$SAVED_DIR"

# ---- Admin password ---------------------------------------------------------
# Generated on the instance and never stored in AWS or in this repo. Lives on the
# save volume so it survives instance replacement. Read it with
# scripts/admin-password.sh.
if [ ! -s "$ADMIN_PW_FILE" ]; then
  log "generating a new admin password"
  # Truncate with bash rather than a trailing `head -c`: closing the pipe early
  # sends SIGPIPE to `tr`, and `pipefail` reports that as a failed pipeline.
  generated=$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
  printf '%s' "${generated:0:24}" > "$ADMIN_PW_FILE"
  chmod 600 "$ADMIN_PW_FILE"
fi

# ---- Server settings --------------------------------------------------------
INI="$SAVED_DIR/Config/LinuxServer/PalWorldSettings.ini"
OVERRIDES=$(jq -n \
  --arg name "$SERVER_NAME" \
  --arg desc "$SERVER_DESCRIPTION" \
  --arg password "$SERVER_PASSWORD" \
  --arg admin "$(admin_password)" \
  --arg port "$GAME_PORT" \
  --arg rest "$REST_PORT" \
  --arg players "$MAX_PLAYERS"   --arg crossplay "$CROSSPLAY_PLATFORMS" \
  '{
    ServerName:           ("\"" + $name + "\""),
    ServerDescription:    ("\"" + $desc + "\""),
    ServerPassword:       ("\"" + $password + "\""),
    AdminPassword:        ("\"" + $admin + "\""),
    PublicPort:           $port,
    ServerPlayerMaxNum:   $players,
    CrossplayPlatforms:   ("(" + $crossplay + ")"),
    RESTAPIEnabled:       "True",
    RESTAPIPort:          $rest,
    bIsUseBackupSaveData: "True"
  }')
python3 "$BIN_DIR/ensure_settings.py" "$INI" "$OVERRIDES"

# ---- Enhanced monitoring ----------------------------------------------------
# Optional, because it costs money. Publishes memory, swap and disk (which EC2 does
# not report on its own) and tails our own logs into CloudWatch. Memory is the one
# worth having on 4 GB: it is the only warning before an out-of-memory kill.
if [ "$ENHANCED_MONITORING" = "true" ]; then
  if ! [ -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl ]; then
    log "installing the CloudWatch agent"
    curl -fsSL -o /tmp/amazon-cloudwatch-agent.deb \
      https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
    dpkg -i -E /tmp/amazon-cloudwatch-agent.deb >/dev/null
  fi

  cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<EOF
{
  "agent": { "metrics_collection_interval": 60, "run_as_user": "root" },
  "metrics": {
    "namespace": "$METRIC_NAMESPACE",
    "append_dimensions": { "InstanceId": "\${aws:InstanceId}" },
    "aggregation_dimensions": [["InstanceId"]],
    "metrics_collected": {
      "mem": { "measurement": [{ "name": "mem_used_percent", "rename": "MemoryUsedPercent" }] },
      "swap": { "measurement": [{ "name": "swap_used_percent", "rename": "SwapUsedPercent" }] },
      "disk": {
        "resources": ["/"],
        "ignore_file_system_types": ["sysfs", "devtmpfs", "tmpfs", "overlay"],
        "measurement": [{ "name": "used_percent", "rename": "DiskUsedPercent" }]
      }
    }
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/palworld-bootstrap.log",
            "log_group_name": "$INSTANCE_LOG_GROUP",
            "log_stream_name": "{instance_id}/bootstrap",
            "retention_in_days": -1
          },
          {
            "file_path": "/var/log/palworld.log",
            "log_group_name": "$INSTANCE_LOG_GROUP",
            "log_stream_name": "{instance_id}/scripts",
            "retention_in_days": -1
          }
        ]
      }
    }
  }
}
EOF

  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json >/dev/null
  log "CloudWatch agent running"
elif [ -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl ]; then
  # Switched off after having been on. Stop publishing so the metrics stop billing.
  log "stopping the CloudWatch agent (enhanced monitoring is off)"
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a stop -m ec2 >/dev/null || true
fi

# Registers the server in the in-game Community Servers browser. The public address
# is auto-detected, so nothing here needs to know the instance's current IP.
if [ "$COMMUNITY_SERVER" = "true" ]; then
  COMMUNITY_FLAG=$'
      - -publiclobby'
  log "community server listing enabled (players search for \"$SERVER_NAME\")"
else
  COMMUNITY_FLAG=""
fi

# ---- Compose ----------------------------------------------------------------
# Mirrors the official compose.yaml from
# https://github.com/pocketpairjp/palworld-dedicated-server-docker, with the save
# directory pointed at the persistent volume and the REST API bound to loopback.
#
# The game's own stdout goes to CloudWatch through Docker's awslogs driver when
# enhanced monitoring is on. Shipping continuously matters: a hard out-of-memory
# kill skips the graceful shutdown, so anything written only at stop time would be
# lost in exactly the case you need it.
if [ "$ENHANCED_MONITORING" = "true" ]; then
  LOGGING_BLOCK=$(cat <<EOF
    logging:
      driver: awslogs
      options:
        awslogs-region: $REGION
        awslogs-group: $INSTANCE_LOG_GROUP
        awslogs-stream: game
        mode: non-blocking
EOF
)
else
  LOGGING_BLOCK=""
fi

cat > "$INSTALL_DIR/compose.yaml" <<EOF
services:
  palworld-server:
    image: $PALWORLD_IMAGE
    container_name: palworld
    entrypoint: /pal/helper.sh
    stop_grace_period: 90s
    command:
      - -port=$GAME_PORT
      - -useperfthreads
      - -NoAsyncLoadingThread
      - -UseMultithreadForDS$COMMUNITY_FLAG
    ports:
      - "$GAME_PORT:$GAME_PORT/udp"
      - "127.0.0.1:$REST_PORT:$REST_PORT/tcp"
    volumes:
      - $BIN_DIR/helper.sh:/pal/helper.sh:ro
      - $SAVED_DIR:/pal/Package/Pal/Saved
$LOGGING_BLOCK
EOF

# Pull here rather than letting systemd's ExecStart do it. The image carries a
# ~5.4 GB layer, and on first boot that download is far longer than any sensible
# service start timeout.
# Drop other versions of the image BEFORE pulling, not after.
#
# One unpacked image occupies about 7.3 GB, and a 30 GB root running this stack has
# roughly 4.8 GB free. Pulling a second version alongside the first needs more room
# than that, so a pull-then-prune ordering runs out of disk partway through and the
# update fails. Freeing the space first means only one version is ever on disk.
#
# Safe when the target is already present: the grep -v keeps it, so a normal boot
# deletes nothing and re-pull is a no-op. Deliberately not `docker image prune -a`,
# which would delete the target itself, since no container is running yet.
stale=$(docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null \
  | grep "^${PALWORLD_IMAGE%%:*}:" \
  | grep -v "^${PALWORLD_IMAGE} " \
  | awk '{print $2}' || true)
if [ -n "$stale" ]; then
  log "removing superseded image versions to make room for $PALWORLD_IMAGE"
  # shellcheck disable=SC2086
  docker rmi -f $stale >/dev/null 2>&1 || true
fi

log "pulling $PALWORLD_IMAGE (root volume $(df -h --output=avail / | tail -1 | tr -d ' ') free)"
docker pull "$PALWORLD_IMAGE"
log "root volume now $(df -h --output=pcent / | tail -1 | tr -d ' ') full"

# ---- systemd ----------------------------------------------------------------
cat > /etc/systemd/system/palworld.service <<EOF
[Unit]
Description=Palworld dedicated server
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=PAL_REST_PORT=$REST_PORT
ExecStart=/usr/bin/docker compose up --abort-on-container-exit
# Runs while the server is still alive, so the save actually flushes.
ExecStop=$BIN_DIR/pre-stop.sh
ExecStop=/usr/bin/docker compose down --timeout 90
Restart=always
RestartSec=15
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
EOF

install_timer() {
  local name=$1 description=$2 command=$3 boot_delay=$4 interval=$5
  cat > "/etc/systemd/system/${name}.service" <<EOF
[Unit]
Description=$description
# None of these should run before bootstrap has fetched the runtime config and
# mounted the save volume. palworld-boot is a oneshot with RemainAfterExit, so
# this orders against its completion rather than merely its start.
Requires=palworld-boot.service
After=palworld-boot.service

[Service]
Type=oneshot
Environment=PAL_REST_PORT=$REST_PORT
ExecStart=$command
EOF
  cat > "/etc/systemd/system/${name}.timer" <<EOF
[Unit]
Description=$description (timer)

[Timer]
OnBootSec=$boot_delay
OnUnitActiveSec=$interval
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
}

install_timer palworld-backup "Back up Palworld saves to S3" \
  "$BIN_DIR/backup.sh" 5min "${BACKUP_INTERVAL_MINUTES}min"
# Starts almost immediately rather than waiting out a boot delay. An early run is
# harmless: while the game is still starting, the REST API refuses the connection,
# idle-check logs that and exits without publishing or touching the idle counter. A
# five-minute delay here just meant five minutes of empty graphs after every wake,
# which reads as a broken server.
install_timer palworld-idle "Stop the server when nobody is playing" \
  "$BIN_DIR/idle-check.sh" 30s 1min
install_timer palworld-dns "Keep the DNS record pointed at this instance" \
  "$BIN_DIR/dns-update.sh" 15s 5min

systemctl daemon-reload
systemctl enable --now palworld-backup.timer palworld-idle.timer palworld-dns.timer

# Point DNS at this boot's public IP before the server is joinable, so the record
# is correct by the time anyone retries.
"$BIN_DIR/dns-update.sh" || log "WARNING: DNS update failed; the 5-minute timer will retry"

log "starting palworld.service"
systemctl restart palworld.service

log "=== bootstrap complete ==="
