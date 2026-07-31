#!/usr/bin/env bash
# Put the server to sleep now instead of waiting out the idle timer.
#
# Goes through SSM so the in-instance shutdown path runs: save the world, take a
# final backup, stop the container, then stop the instance. A plain
# `aws ec2 stop-instances` would skip straight to the OS shutdown.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

id=$(instance_id)

command_id=$(aws ssm send-command \
  --instance-ids "$id" \
  --document-name AWS-RunShellScript \
  --comment 'Graceful Palworld shutdown' \
  --parameters 'commands=["/opt/palworld/bin/shutdown-now.sh"]' \
  --query 'Command.CommandId' --output text)

echo "Sent graceful shutdown (command ${command_id})."
echo "The world is saved and backed up before the instance stops."
