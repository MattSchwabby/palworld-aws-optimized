#!/usr/bin/env bash
# Point the game's DNS record at whatever public IP this boot happened to get.
#
# There is deliberately no Elastic IP: a public IPv4 costs $0.005/hour whether or
# not the instance is running, so an EIP would bill around the clock for a server
# that is asleep most of the week. Re-asserting the record on a 5-minute timer
# also means a redeploy that resets the record to its parked value self-heals.
set -euo pipefail

source /opt/palworld/bin/lib.sh

# With an Elastic IP the address never changes, so there is nothing to update and no
# hosted zone to update it in.
if [ "$ADDRESSING" != "route53" ]; then
  exit 0
fi

IP=$(public_ip)
if [ -z "$IP" ]; then
  log "no public IPv4 available from instance metadata"
  exit 1
fi

current=$(aws route53 list-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --query "ResourceRecordSets[?Name=='${RECORD_NAME}.' && Type=='A'].ResourceRecords[0].Value | [0]" \
  --output text 2>/dev/null || echo "")

if [ "$current" = "$IP" ]; then
  exit 0
fi

batch=$(jq -n --arg name "$RECORD_NAME" --arg ip "$IP" --argjson ttl "$DNS_TTL" '{
  Comment: "palworld server address",
  Changes: [{
    Action: "UPSERT",
    ResourceRecordSet: { Name: $name, Type: "A", TTL: $ttl, ResourceRecords: [{ Value: $ip }] }
  }]
}')

aws route53 change-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch "$batch" >/dev/null

log "DNS updated: $RECORD_NAME -> $IP (was ${current:-unset})"
