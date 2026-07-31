#!/usr/bin/env bash
# Wake the server by hand. Normally unnecessary -- connecting from the game does
# this automatically -- but useful for warming it up before friends arrive.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

id=$(instance_id)
state=$(aws ec2 describe-instances --instance-ids "$id" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)

case "$state" in
  running) echo "Already running." ;;
  stopped)
    aws ec2 start-instances --instance-ids "$id" >/dev/null
    echo "Starting ${id}. Joinable in roughly 2 minutes."
    ;;
  *) echo "Instance is ${state}; wait for it to settle and try again." ;;
esac
