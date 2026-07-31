"""Start the Palworld instance when someone resolves its DNS name.

Invoked by a CloudWatch Logs subscription filter on the Route 53 query log. The
filter has already matched the hostname, so there is nothing to parse out of the
(gzipped, base64'd) payload — the invocation itself is the signal.

The instance is located by tag rather than by a baked-in ID, so replacing the
instance does not require redeploying this function.
"""

import os

import boto3

TARGET_REGION = os.environ["TARGET_REGION"]
TAG_KEY = "tag:Application"
TAG_VALUE = "palworld"

ec2 = boto3.client("ec2", region_name=TARGET_REGION)


def handler(event, context):
    response = ec2.describe_instances(
        Filters=[
            {"Name": TAG_KEY, "Values": [TAG_VALUE]},
            # 'terminated' and 'shutting-down' are excluded so a torn-down instance
            # is never mistaken for a sleeping one.
            {
                "Name": "instance-state-name",
                "Values": ["pending", "running", "stopping", "stopped"],
            },
        ]
    )

    instances = [
        instance
        for reservation in response["Reservations"]
        for instance in reservation["Instances"]
    ]

    if not instances:
        print("no palworld instance found")
        return {"action": "noop", "reason": "no-instance"}

    started = []
    for instance in instances:
        instance_id = instance["InstanceId"]
        state = instance["State"]["Name"]

        if state == "stopped":
            ec2.start_instances(InstanceIds=[instance_id])
            print(f"{instance_id}: was stopped, start requested")
            started.append(instance_id)
        else:
            # 'stopping' is the one worth calling out: EC2 rejects StartInstances
            # until that transition finishes. The player's retry a minute later
            # produces another DNS query, and another invocation, which succeeds.
            print(f"{instance_id}: state is {state}, nothing to do")

    return {"action": "started" if started else "noop", "instances": started}
