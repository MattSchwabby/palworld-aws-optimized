#!/usr/bin/env bash
# Pull recent server logs without opening a shell.
#
# Usage: logs.sh [bootstrap|server|idle|backup|dns]
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

case "${1:-server}" in
  bootstrap) remote='tail -n 200 /var/log/palworld-bootstrap.log' ;;
  server)    remote='journalctl -u palworld.service -n 200 --no-pager' ;;
  idle)      remote='journalctl -u palworld-idle.service -n 100 --no-pager' ;;
  backup)    remote='journalctl -u palworld-backup.service -n 100 --no-pager' ;;
  dns)       remote='journalctl -u palworld-dns.service -n 100 --no-pager' ;;
  *) echo "usage: $0 [bootstrap|server|idle|backup|dns]" >&2; exit 2 ;;
esac

command_id=$(aws ssm send-command \
  --instance-ids "$(instance_id)" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"${remote}\"]" \
  --query 'Command.CommandId' --output text)

# send-command is asynchronous; give the agent a moment before collecting output.
sleep 5
aws ssm get-command-invocation \
  --command-id "$command_id" \
  --instance-id "$(instance_id)" \
  --query 'StandardOutputContent' --output text
