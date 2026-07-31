#!/usr/bin/env bash
# Print exactly what a player needs to join.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

address=$(stack_output ConnectAddress)
name=$(stack_output ConnectServerName)
password=$(stack_output ConnectPassword)

cat <<EOF
================ How to join ================
  In Palworld: Join Multiplayer Game, then type the address into
  the field at the bottom of the screen.

  Address     ${address}
  Server name ${name}
  Password    ${password}

  The :port is required. Palworld will not connect to a bare
  hostname, and it ignores SRV records.

  If the server is asleep, the first attempt fails on purpose --
  that connection is what wakes it. Wait ~2 minutes and retry.
=============================================
EOF
