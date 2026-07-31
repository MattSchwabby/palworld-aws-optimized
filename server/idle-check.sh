#!/usr/bin/env bash
# Once a minute: publish the player count, and stop the instance once the server
# has been empty long enough. This is the mechanism that keeps the bill small.
set -euo pipefail

source /opt/palworld/bin/lib.sh

instance=$(instance_id)

# Publishes 1 or 0 for "is the game answering", separately from the player count.
# This timer runs whether or not the game is up, so a zero here is a real
# observation rather than a gap on a chart, and a boot shows up as a couple of
# minutes at zero instead of looking identical to an empty server.
publish_health() {
  aws cloudwatch put-metric-data \
    --namespace "$METRIC_NAMESPACE" \
    --metric-name "$HEALTH_METRIC_NAME" \
    --dimensions "InstanceId=$1" \
    --value "$2" --unit None >/dev/null 2>&1 || log "failed to publish the health metric"
}

if ! players=$(python3 "$BIN_DIR/palctl.py" count 2>/dev/null); then
  # Still starting, or wedged. Deliberately publish no player count: the idle
  # counter must not read "unknown" as "empty", and the backstop treats a missing
  # count as a reason to stop the instance rather than bill for it forever.
  publish_health "$instance" 0
  log "game not answering (starting or unhealthy)"
  exit 0
fi

publish_health "$instance" 1

aws cloudwatch put-metric-data \
  --namespace "$METRIC_NAMESPACE" \
  --metric-name "$PLAYER_METRIC_NAME" \
  --dimensions "InstanceId=${instance}" \
  --value "$players" \
  --unit Count || log "failed to publish player metric"

if [ "$players" -gt 0 ]; then
  echo 0 > "$IDLE_STATE_FILE"
  exit 0
fi

idle=$(( $(cat "$IDLE_STATE_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$idle" > "$IDLE_STATE_FILE"
log "server empty for ${idle}/${IDLE_SHUTDOWN_MINUTES} minutes"

if [ "$idle" -ge "$IDLE_SHUTDOWN_MINUTES" ]; then
  log "idle threshold reached"
  exec "$BIN_DIR/shutdown-now.sh"
fi
