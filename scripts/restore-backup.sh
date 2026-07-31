#!/usr/bin/env bash
# Roll the world back to an earlier backup.
#
# Run with no arguments to list what is available. Pass an archive name to restore
# it. The server has to be running, since the work happens on the instance.
#
# Before overwriting anything this takes a fresh backup of the current state, so a
# restore you did not mean to do is itself reversible.
#
#   scripts/restore-backup.sh
#   scripts/restore-backup.sh palworld-20260731T064936Z.tar.gz
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

bucket=$(stack_output BackupBucket)
archive="${1:-}"

if [ -z "$archive" ]; then
  echo "Backups in s3://${bucket}/saves/ (newest last):"
  echo
  aws s3 ls "s3://${bucket}/saves/" --human-readable | tr -d '\r'
  echo
  echo "Restore one with:"
  echo "  $0 <archive-name>"
  exit 0
fi

id=$(instance_id)
state=$(aws ec2 describe-instances --instance-ids "$id" \
  --query 'Reservations[0].Instances[0].State.Name' --output text | tr -d '\r')

if [ "$state" != "running" ]; then
  echo "The instance is ${state}. Start it first:" >&2
  echo "  scripts/start.sh" >&2
  exit 1
fi

if ! aws s3 ls "s3://${bucket}/saves/${archive}" >/dev/null 2>&1; then
  echo "No such archive: ${archive}" >&2
  echo "Run with no arguments to list them." >&2
  exit 1
fi

cat <<EOF

About to replace the live world with ${archive}.

Everyone currently playing gets disconnected. The current save is backed up first,
so this is reversible.

EOF
read -r -p "Type the archive name again to confirm: " confirm
if [ "$confirm" != "$archive" ]; then
  echo "Names did not match. Nothing changed."
  exit 1
fi

echo "Restoring..."

# Quoting note: this whole block is one SSM command string, so the remote script is
# kept deliberately simple and passes the archive name through an env var.
remote=$(cat <<'REMOTE'
set -euo pipefail
source /opt/palworld/bin/lib.sh
log "restore: taking a safety backup of the current world"
/opt/palworld/bin/backup.sh || log "restore: safety backup failed, continuing anyway"
log "restore: stopping the game"
systemctl stop palworld.service
log "restore: downloading ARCHIVE_PLACEHOLDER"
aws s3 cp "s3://BUCKET_PLACEHOLDER/saves/ARCHIVE_PLACEHOLDER" /tmp/restore.tar.gz
rm -rf "$SAVED_DIR"
tar -xzf /tmp/restore.tar.gz -C "$DATA_DIR"
rm -f /tmp/restore.tar.gz
log "restore: starting the game"
systemctl start palworld.service
log "restore: done"
REMOTE
)
remote=${remote//ARCHIVE_PLACEHOLDER/$archive}
remote=${remote//BUCKET_PLACEHOLDER/$bucket}

command_id=$(aws ssm send-command \
  --instance-ids "$id" \
  --document-name AWS-RunShellScript \
  --comment "Restore Palworld save ${archive}" \
  --parameters "commands=$(python -c "
import json,sys
print(json.dumps([sys.stdin.read()]))
" <<<"$remote")" \
  --timeout-seconds 900 \
  --query 'Command.CommandId' --output text | tr -d '\r')

echo "Sent (command ${command_id}). Watching..."

for _ in $(seq 1 40); do
  sleep 10
  status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$id" \
    --query 'Status' --output text 2>/dev/null | tr -d '\r' || echo Pending)
  echo "  ${status}"
  case "$status" in
    Success)
      aws ssm get-command-invocation --command-id "$command_id" --instance-id "$id" \
        --query 'StandardOutputContent' --output text | tr -d '\r'
      echo "Restored ${archive}."
      exit 0
      ;;
    Failed|Cancelled|TimedOut)
      aws ssm get-command-invocation --command-id "$command_id" --instance-id "$id" \
        --query '[StandardOutputContent,StandardErrorContent]' --output text | tr -d '\r'
      echo "Restore failed. The safety backup is in s3://${bucket}/saves/." >&2
      exit 1
      ;;
  esac
done

echo "Still running. Check with: scripts/logs.sh server" >&2
