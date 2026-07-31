#!/usr/bin/env bash
# Deploy both stacks, then publish the Route 53 nameservers to Cloudflare.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"
cd "$ROOT_DIR"

npx cdk deploy --all --require-approval never "$@"

echo
echo "Publishing the subdomain delegation to Cloudflare..."
"$ROOT_DIR/scripts/sync-cloudflare-ns.sh"

echo
"$ROOT_DIR/scripts/how-to-connect.sh"
