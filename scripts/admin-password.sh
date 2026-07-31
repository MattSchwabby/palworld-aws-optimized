#!/usr/bin/env bash
# Print the server's in-game admin password.
#
# It is generated on the instance at first boot and stored only on the save
# volume -- never in this repo, never in Secrets Manager. Use it for in-game admin
# commands, and for hitting the REST API if you shell in.
#
# The instance must be running.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

command_id=$(aws ssm send-command \
  --instance-ids "$(instance_id)" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cat /opt/palworld/data/admin_password"]' \
  --query 'Command.CommandId' --output text)

sleep 4
aws ssm get-command-invocation \
  --command-id "$command_id" \
  --instance-id "$(instance_id)" \
  --query 'StandardOutputContent' --output text
