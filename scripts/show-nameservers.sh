#!/usr/bin/env bash
# Print the NS records to add at your registrar, for anyone not using Cloudflare.
#
# This is the one manual step in 'route53' addressing. You are delegating a single
# subdomain to Route 53 so it can answer, and log, the lookups that wake your
# server. Every other record in your domain keeps working exactly as it does now,
# because delegation only covers the label you delegate.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

addressing=$(stack_output Addressing | tr -d '\r')
if [ "$addressing" != "route53" ]; then
  echo "Addressing is '${addressing}', so there is no delegation to set up."
  echo "Players connect straight to the Elastic IP:"
  echo "  $(stack_output ConnectAddress | tr -d '\r')"
  exit 0
fi

domain=$(stack_output DomainName | tr -d '\r')
nameservers=$(stack_output NameServers | tr -d '\r')

if [ -z "$nameservers" ] || [ "$nameservers" = "None" ]; then
  echo "Could not read NameServers from stack ${STACK_NAME}." >&2
  exit 1
fi

subdomain="${domain%%.*}"

cat <<EOF

Add these NS records at whoever hosts your domain's DNS.

  Type   NS
  Name   ${subdomain}          (some panels want the full ${domain})
  TTL    300 or the default

  Values:
EOF

IFS=',' read -ra servers <<<"$nameservers"
for ns in "${servers[@]}"; do
  echo "    ${ns%.}"
done

cat <<EOF

On Cloudflare, run scripts/sync-cloudflare-ns.sh and it does this for you.

Check it took effect:
  dig NS ${domain} +short

Propagation usually takes a few minutes.
EOF
