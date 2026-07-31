"""Cost backstop: stop the instance if the on-instance idle check has failed.

The primary shutdown path lives on the instance itself (idle-check.sh), which
saves and backs up before stopping. This exists for the case where that path is
not running at all — a wedged agent, a crashed game server, a broken deploy —
because the failure mode is a box that bills 24/7 while nobody is playing.

Why a scheduled Lambda instead of a CloudWatch alarm with an EC2 stop action:
an alarm cannot tell "instance stopped, so no metrics" apart from "instance
running but reporting nothing". With treatMissingData=BREACHING it sits in ALARM
forever and kills instances during boot; with MISSING it never fires at all. A
scheduled check reads instance state first, which removes the ambiguity.
"""

import os
from datetime import datetime, timedelta, timezone

import boto3

TARGET_REGION = os.environ["TARGET_REGION"]
METRIC_NAMESPACE = os.environ["METRIC_NAMESPACE"]
METRIC_NAME = os.environ["METRIC_NAME"]
HARD_STOP_MINUTES = int(os.environ["HARD_STOP_MINUTES"])
# Long enough to cover a cold boot: apt, the Docker install, and a ~5.4 GB image
# pull all happen before the game server can report anything.
BOOT_GRACE_MINUTES = int(os.environ["BOOT_GRACE_MINUTES"])
TAG_VALUE = "palworld"

ec2 = boto3.client("ec2", region_name=TARGET_REGION)
cloudwatch = boto3.client("cloudwatch", region_name=TARGET_REGION)


def _running_instances():
    response = ec2.describe_instances(
        Filters=[
            {"Name": "tag:Application", "Values": [TAG_VALUE]},
            {"Name": "instance-state-name", "Values": ["running"]},
        ]
    )
    return [
        instance
        for reservation in response["Reservations"]
        for instance in reservation["Instances"]
    ]


def _player_datapoints(instance_id, window_start, now):
    response = cloudwatch.get_metric_statistics(
        Namespace=METRIC_NAMESPACE,
        MetricName=METRIC_NAME,
        Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
        StartTime=window_start,
        EndTime=now,
        Period=60,
        Statistics=["Maximum"],
    )
    return response["Datapoints"]


def handler(event, context):
    now = datetime.now(timezone.utc)
    results = []

    for instance in _running_instances():
        instance_id = instance["InstanceId"]

        # LaunchTime is refreshed each time a stopped instance is started, so this
        # is uptime for the current run, not age since first creation.
        uptime = now - instance["LaunchTime"]
        if uptime < timedelta(minutes=BOOT_GRACE_MINUTES):
            print(f"{instance_id}: up {uptime}, inside boot grace period")
            results.append({"instance": instance_id, "action": "grace"})
            continue

        window_start = now - timedelta(minutes=HARD_STOP_MINUTES)
        datapoints = _player_datapoints(instance_id, window_start, now)

        if not datapoints:
            reason = f"no player metric for {HARD_STOP_MINUTES} minutes (agent not reporting)"
        elif max(point["Maximum"] for point in datapoints) == 0:
            reason = f"empty for {HARD_STOP_MINUTES} minutes and still running"
        else:
            print(f"{instance_id}: players seen recently, leaving it alone")
            results.append({"instance": instance_id, "action": "noop"})
            continue

        # A blunt stop: the graceful save/backup path did not run, by definition.
        # Palworld autosaves every 30s and backups run every 15 minutes, so the
        # worst case is a small amount of lost progress rather than a lost world.
        print(f"{instance_id}: stopping — {reason}")
        ec2.stop_instances(InstanceIds=[instance_id])
        results.append({"instance": instance_id, "action": "stopped", "reason": reason})

    return {"checked": len(results), "results": results}
