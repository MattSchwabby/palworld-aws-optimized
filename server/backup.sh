#!/usr/bin/env bash
# Snapshot the world to S3. Runs on a timer, and again just before every shutdown.
set -euo pipefail

source /opt/palworld/bin/lib.sh

if [ -z "$(ls -A "$SAVED_DIR" 2>/dev/null || true)" ]; then
  log "no save data yet; nothing to back up"
  exit 0
fi

# Flush memory to disk first so the archive is a clean point in time. Best effort:
# if the server is mid-boot the API will not answer, and the on-disk save is at
# most AutoSaveSpan (30s) stale anyway.
python3 "$BIN_DIR/palctl.py" save >/dev/null 2>&1 \
  || log "save endpoint unavailable; archiving on-disk state as-is"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="/tmp/palworld-${timestamp}.tar.gz"

tar -czf "$archive" -C "$DATA_DIR" Saved
aws s3 cp "$archive" "s3://$BACKUP_BUCKET/saves/palworld-${timestamp}.tar.gz" --only-show-errors
rm -f "$archive"
log "backed up palworld-${timestamp}.tar.gz"

# Heartbeat so a backup that quietly stops working becomes visible. Without this,
# a failing upload writes a line to the journal on a box you cannot read while it is
# stopped, and nothing else ever mentions it. The alarm in the monitoring stack
# looks for the absence of this.
aws cloudwatch put-metric-data \
  --namespace "$METRIC_NAMESPACE" \
  --metric-name "$BACKUP_METRIC_NAME" \
  --dimensions "InstanceId=$(instance_id)" \
  --value 1 --unit Count >/dev/null 2>&1 || log "could not publish the backup metric"

# Keep the N most recent. The bucket's lifecycle rule expires by age, which is a
# backstop rather than a substitute: age alone would not bound the object count
# during a heavy week of play.
# `|| true` because `aws s3 ls` exits non-zero on an empty prefix, which pipefail
# would otherwise turn into a failed backup run.
listing=$(aws s3 ls "s3://$BACKUP_BUCKET/saves/" 2>/dev/null || true)
printf '%s\n' "$listing" \
  | awk '{print $4}' \
  | sort \
  | head -n "-${BACKUPS_TO_KEEP}" \
  | while read -r key; do
      [ -n "$key" ] || continue
      aws s3 rm "s3://$BACKUP_BUCKET/saves/${key}" --only-show-errors
      log "pruned old backup ${key}"
    done
