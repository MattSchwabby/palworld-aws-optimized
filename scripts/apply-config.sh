#!/usr/bin/env bash
# Apply config.ts changes to a *running* server without waiting for it to cycle.
#
# A deploy publishes new settings to SSM and new scripts to S3, but the instance
# only reads those at boot — so a running server keeps using whatever it started
# with. This re-runs the bootstrap in place: it re-reads SSM, re-downloads server/,
# rewrites PalWorldSettings.ini, and restarts the game container.
#
# It DOES restart the game, so anyone connected is dropped. The restart is graceful
# (save + backup run first), so nothing is lost. If nobody is playing, this is free
# of consequence; if they are, wait or use scripts/stop.sh instead.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

id=$(instance_id)

state=$(aws ec2 describe-instances --instance-ids "$id" \
  --query 'Reservations[0].Instances[0].State.Name' --output text | tr -d '\r')

if [ "$state" != "running" ]; then
  echo "Instance is ${state} — nothing to do."
  echo "Config changes are read at boot, so the next wake picks them up automatically."
  exit 0
fi

echo "Re-running bootstrap on ${id} (the game will restart)..."

command_id=$(aws ssm send-command \
  --instance-ids "$id" \
  --document-name AWS-RunShellScript \
  --comment 'Re-apply Palworld runtime config' \
  --parameters 'commands=["systemctl restart palworld-boot.service","systemctl is-active palworld.service"]' \
  --timeout-seconds 900 \
  --query 'Command.CommandId' --output text | tr -d '\r')

echo "Sent (command ${command_id}). Give it a minute, then:"
echo "  scripts/logs.sh bootstrap"
