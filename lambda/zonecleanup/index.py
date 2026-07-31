"""Empty the hosted zone when the stack is torn down.

Route 53 refuses to delete a zone that still holds records, and CloudFormation
cannot remove the one record that matters here. CloudFormation creates the A record
pointing at the parked address, then the instance rewrites it to its real IP on every
boot. At delete time CloudFormation asks Route 53 to remove a record with the value
it remembers, that value no longer matches, the record survives, and the zone delete
fails with HostedZoneNotEmptyException.

Rather than fight the drift, this deletes whatever is actually in the zone on the way
out, skipping the apex NS and SOA records that Route 53 owns and requires.

Only runs on Delete. Create and Update do nothing.
"""

import os

import boto3

route53 = boto3.client("route53")

ZONE_ID = os.environ["HOSTED_ZONE_ID"]
ZONE_NAME = os.environ["ZONE_NAME"].rstrip(".") + "."


def _deletable_records():
    """Everything Route 53 will let us remove, which is everything except the
    apex NS and SOA it maintains itself."""
    paginator = route53.get_paginator("list_resource_record_sets")
    for page in paginator.paginate(HostedZoneId=ZONE_ID):
        for record in page["ResourceRecordSets"]:
            if record["Name"] == ZONE_NAME and record["Type"] in ("NS", "SOA"):
                continue
            yield record


def handler(event, context):
    request_type = event["RequestType"]

    if request_type != "Delete":
        print(f"{request_type}: nothing to do")
        return {"PhysicalResourceId": f"zone-cleanup-{ZONE_ID}"}

    changes = [
        {"Action": "DELETE", "ResourceRecordSet": record} for record in _deletable_records()
    ]

    if not changes:
        print("zone already empty")
    else:
        for record in changes:
            rrs = record["ResourceRecordSet"]
            print(f"deleting {rrs['Type']} {rrs['Name']}")
        # One batch, so a partial failure leaves nothing half-removed.
        route53.change_resource_record_sets(
            HostedZoneId=ZONE_ID,
            ChangeBatch={"Comment": "stack teardown", "Changes": changes},
        )
        print(f"deleted {len(changes)} record(s)")

    return {"PhysicalResourceId": f"zone-cleanup-{ZONE_ID}"}
