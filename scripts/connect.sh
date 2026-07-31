#!/usr/bin/env bash
# Open a shell on the instance via SSM Session Manager.
#
# There is no SSH port open and no key pair anywhere in this stack -- Session
# Manager tunnels over the instance's outbound connection instead, so the only
# inbound port on the security group is the game itself.
#
# Requires the Session Manager plugin:
#   https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

exec aws ssm start-session --target "$(instance_id)"
