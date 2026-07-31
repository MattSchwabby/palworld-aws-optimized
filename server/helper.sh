#!/bin/sh
# Entrypoint required by the official Pocketpair image. Reproduced from
# https://github.com/pocketpairjp/palworld-dedicated-server-docker
#
# The bind-mounted save directory arrives owned by the host's root; the server
# process runs as an unprivileged user and needs to own it before starting.
sudo chown -R user:usergroup /pal/Package/Pal/Saved
exec /bin/sh /pal/Package/PalServer.sh "$@"
