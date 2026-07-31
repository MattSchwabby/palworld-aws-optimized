#!/usr/bin/env bash
# What is the server doing right now?
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

id=$(instance_id)
address=$(stack_output ConnectAddress)
record="${address%%:*}"

# tr -d '\r': the AWS CLI emits CRLF on Windows, and a trailing carriage return
# silently breaks the string comparison against the resolved address below.
read -r state public_ip < <(
  aws ec2 describe-instances --instance-ids "$id" \
    --query 'Reservations[0].Instances[0].[State.Name,PublicIpAddress]' --output text | tr -d '\r'
)

echo "Instance     ${id}"
echo "State        ${state}"
echo "Public IP    ${public_ip}"
echo "Address      ${address}"

# Read the record straight out of Route 53 rather than resolving it.
#
# This matters: a real DNS lookup is the wake trigger, so checking status with a
# resolver would start the server every time you asked whether it was running.
# The Route 53 API reads the record without generating a query.
zone=$(stack_output HostedZoneId)
resolved=$(aws route53 list-resource-record-sets --hosted-zone-id "$zone" \
  --query "ResourceRecordSets[?Name=='${record}.' && Type=='A'].ResourceRecords[0].Value | [0]" \
  --output text 2>/dev/null | tr -d '\r' || echo 'unknown')

echo "DNS record  ${resolved}"

if [ "$state" = "running" ] && [ "$public_ip" != "$resolved" ]; then
  echo
  echo "note: DNS has not caught up with the current IP yet (the on-instance"
  echo "      timer re-asserts it every 5 minutes)."
fi

echo
echo "Players online (last hour):"
aws cloudwatch get-metric-statistics \
  --namespace Palworld --metric-name PlayersOnline \
  --dimensions "Name=InstanceId,Value=${id}" \
  --start-time "$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 300 --statistics Maximum \
  --query 'sort_by(Datapoints,&Timestamp)[-6:].[Timestamp,Maximum]' --output text \
  || echo "  (no datapoints)"
