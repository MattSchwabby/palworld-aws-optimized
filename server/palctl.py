#!/usr/bin/env python3
"""Minimal client for Palworld's built-in REST API.

Pocketpair's own docs say these endpoints "are not designed to be exposed directly
to the Internet", so the container publishes the API on 127.0.0.1 only and nothing
here ever crosses the network. Auth is HTTP Basic as `admin` with the server's
AdminPassword.

Used for three things: counting players (drives idle shutdown), flushing a save
before a backup, and shutting down gracefully.
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.request

# Kept in step with config.ts restApiPort, which the callers export.
DEFAULT_PORT = int(os.environ.get("PAL_REST_PORT", "8212"))
ADMIN_PASSWORD_FILE = "/opt/palworld/data/admin_password"


def _call(path, method="GET", payload=None, port=DEFAULT_PORT, timeout=10):
    with open(ADMIN_PASSWORD_FILE) as handle:
        password = handle.read().strip()

    credentials = base64.b64encode(f"admin:{password}".encode()).decode()
    body = json.dumps(payload).encode() if payload is not None else None

    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )

    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode().strip()

    return json.loads(raw) if raw else {}


def main(argv):
    if len(argv) < 2:
        print("usage: palctl.py {players|count|info|save|shutdown}", file=sys.stderr)
        return 2

    command = argv[1]

    try:
        if command == "count":
            # Printed on stdout and consumed by idle-check.sh. A non-zero exit here
            # means "unknown", which is deliberately different from "zero players":
            # the former must not count toward the idle timer.
            print(len(_call("/v1/api/players").get("players", [])))
        elif command == "players":
            print(json.dumps(_call("/v1/api/players"), indent=2))
        elif command == "info":
            print(json.dumps(_call("/v1/api/info"), indent=2))
        elif command == "save":
            _call("/v1/api/save", method="POST")
            print("saved")
        elif command == "shutdown":
            _call(
                "/v1/api/shutdown",
                method="POST",
                payload={"waittime": 10, "message": "Server going to sleep. Progress saved."},
            )
            print("shutdown requested")
        else:
            print(f"unknown command: {command}", file=sys.stderr)
            return 2
    except (urllib.error.URLError, OSError, ValueError) as error:
        # Normal during the ~2 minutes between instance boot and the game server
        # binding its port.
        print(f"palworld API unavailable: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
