#!/usr/bin/env bash
# Put the server to sleep: stop the game cleanly, then stop the EC2 instance.
#
# Stopping palworld.service triggers pre-stop.sh, so the save and final backup
# happen before anything is torn down. The EBS volumes survive the stop untouched
# — this is a pause, not a teardown.
set -uo pipefail

source /opt/palworld/bin/lib.sh

instance=$(instance_id)

log "stopping the game server (saves and backs up on the way out)"
systemctl stop palworld.service || log "palworld.service did not stop cleanly"

log "stopping instance ${instance}"
aws ec2 stop-instances --instance-ids "$instance" >/dev/null
