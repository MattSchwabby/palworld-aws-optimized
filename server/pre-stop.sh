#!/usr/bin/env bash
# First ExecStop of palworld.service. systemd runs ExecStop while the main process
# is still alive, which is exactly what makes this useful: the save endpoint still
# answers, so the world is flushed and archived before the container goes away.
#
# No `set -e` — a failure here must never block the shutdown that follows.
set -uo pipefail

source /opt/palworld/bin/lib.sh

log "pre-stop: flushing world to disk"
python3 "$BIN_DIR/palctl.py" save || log "pre-stop: save endpoint unavailable"

log "pre-stop: taking a final backup"
"$BIN_DIR/backup.sh" || log "pre-stop: backup failed"

exit 0
