#!/usr/bin/env bash
# Delegate one subdomain from Cloudflare to Route 53.
#
# Your apex domain stays on Cloudflare. This adds NS records for a single label, so
# only that one name moves to Route 53. Everything else in the zone keeps resolving
# from Cloudflare exactly as it does now, because delegation covers just the label
# you delegate.
#
# Route 53 can only log lookups for names it is authoritative for, and those logs
# are what wake the server, which is why this step exists at all.
#
# Not on Cloudflare? Run scripts/show-nameservers.sh and add the records by hand.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

addressing=$(stack_output Addressing | tr -d '\r')
if [ "$addressing" != "route53" ]; then
  echo "Addressing is '${addressing}', so there is nothing to delegate. Skipping."
  exit 0
fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN missing from .env}"

# Taken from the deployed stack rather than hardcoded, so this works for any domain.
FQDN=$(stack_output DomainName | tr -d '\r')
APEX_DOMAIN=$(stack_output ApexDomain | tr -d '\r')

nameservers=$(stack_output NameServers | tr -d '\r')
if [ -z "$nameservers" ] || [ "$nameservers" = "None" ]; then
  echo "error: could not read NameServers from stack $STACK_NAME" >&2
  exit 1
fi

cf() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" "https://api.cloudflare.com/client/v4${path}" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -sS -X "$method" "https://api.cloudflare.com/client/v4${path}" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
  fi
}

zone_id=$(cf GET "/zones?name=${APEX_DOMAIN}" | python -c "
import json,sys
zones = json.load(sys.stdin).get('result') or []
print(zones[0]['id'] if zones else '')
")

if [ -z "$zone_id" ]; then
  echo "error: Cloudflare zone ${APEX_DOMAIN} not found (check the API token's zone scope)" >&2
  exit 1
fi

echo "Cloudflare zone ${APEX_DOMAIN}: ${zone_id}"

# Remove any NS records we previously wrote for this name, so re-running after a
# hosted-zone recreation converges instead of stacking stale delegations.
existing=$(cf GET "/zones/${zone_id}/dns_records?type=NS&name=${FQDN}" | python -c "
import json,sys
for record in json.load(sys.stdin).get('result') or []:
    print(record['id'], record['content'])
")

while read -r record_id content; do
  [ -n "${record_id:-}" ] || continue
  if grep -q "$content" <<<"$nameservers"; then
    echo "  keeping  NS ${FQDN} -> ${content}"
  else
    cf DELETE "/zones/${zone_id}/dns_records/${record_id}" >/dev/null
    echo "  removed  NS ${FQDN} -> ${content} (stale)"
  fi
done <<<"$existing"

IFS=',' read -ra servers <<<"$nameservers"
for ns in "${servers[@]}"; do
  ns="${ns%.}"
  [ -n "$ns" ] || continue

  if grep -q "$ns" <<<"$existing"; then
    continue
  fi

  payload=$(python -c "
import json,sys
print(json.dumps({'type':'NS','name':sys.argv[1],'content':sys.argv[2],'ttl':300}))
" "$FQDN" "$ns")

  result=$(cf POST "/zones/${zone_id}/dns_records" "$payload")
  ok=$(python -c "import json,sys; print(json.load(sys.stdin).get('success'))" <<<"$result")

  if [ "$ok" = "True" ]; then
    echo "  added    NS ${FQDN} -> ${ns}"
  else
    echo "  FAILED   NS ${FQDN} -> ${ns}" >&2
    python -c "
import json,sys
for error in json.load(sys.stdin).get('errors') or []:
    print('           ', error.get('message'), file=sys.stderr)
" <<<"$result"
    echo "           (the API token needs Zone:DNS:Edit on ${APEX_DOMAIN})" >&2
    exit 1
  fi
done

echo
echo "Delegation published. DNS propagation takes a few minutes."
