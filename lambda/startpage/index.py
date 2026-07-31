"""A web page with one button that starts the server.

Useful when there is no domain, because nothing else wakes the server on its own.
Served by a Lambda Function URL with no authentication, guarded by a token in the
query string. Someone who has the link can start your server and do nothing else,
which costs one idle timeout of compute.

The instance is found by tag, so replacing it needs no redeploy here.

Two signals are read rather than one. EC2 instance state says whether the box is
on, and the player metric that idle-check.sh publishes every minute says whether
the game itself is answering. Those diverge for the whole of a boot, which is the
window a player is most likely to be staring at this page, so the page reports
them separately: running is not the same as joinable.
"""

import html
import os
from datetime import datetime, timedelta, timezone

import boto3
from botocore.exceptions import ClientError

TARGET_REGION = os.environ["TARGET_REGION"]
ACCESS_TOKEN = os.environ["ACCESS_TOKEN"]
CONNECT_ADDRESS = os.environ["CONNECT_ADDRESS"]
SERVER_NAME = os.environ["SERVER_NAME"]
SERVER_PASSWORD = os.environ["SERVER_PASSWORD"]
IDLE_MINUTES = int(os.environ["IDLE_MINUTES"])
# The stack's own answer to "how long may a boot legitimately take", so the page
# and the watchdog agree on when a silent server has stopped being a slow boot
# and started being a broken one.
BOOT_GRACE_MINUTES = int(os.environ["BOOT_GRACE_MINUTES"])
METRIC_NAMESPACE = os.environ["METRIC_NAMESPACE"]
METRIC_NAME = os.environ["METRIC_NAME"]

# The metric arrives once a minute. Two missed publishes is a stall worth
# reporting rather than a blip worth hiding.
READY_WINDOW_MINUTES = 3
# A warm start is about two minutes. Past this it is probably a first boot
# pulling a 5.4 GB image, which deserves a different sentence than "nearly
# there" so nobody gives up at minute three.
SLOW_BOOT_MINUTES = 4
# Has to cover the whole idle countdown or the sleeps-in estimate reads low.
METRIC_LOOKBACK_MINUTES = max(90, IDLE_MINUTES + 10)
# How often a transitional page reloads itself.
REFRESH_SECONDS = 15

ec2 = boto3.client("ec2", region_name=TARGET_REGION)
cloudwatch = boto3.client("cloudwatch", region_name=TARGET_REGION)

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{refresh}<title>{server_name}</title>
<style>
  :root {{ color-scheme: dark light; }}
  body {{
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 32rem; margin: 0 auto; padding: 2rem 1.25rem;
  }}
  h1 {{ font-size: 1.5rem; margin-bottom: .25rem; }}
  .state {{ font-size: 1.1rem; padding: .75rem 1rem; border-radius: .5rem;
           background: rgba(127,127,127,.15); margin: 1rem 0; }}
  .state.ready {{ background: rgba(47,111,79,.25); }}
  .state.busy {{ background: rgba(190,150,40,.2); }}
  dl {{ display: grid; grid-template-columns: auto 1fr; gap: .35rem 1rem; }}
  dt {{ opacity: .7; }}
  dd {{ margin: 0; font-family: ui-monospace, monospace; }}
  button {{ font-size: 1.1rem; padding: .8rem 1.5rem; border-radius: .5rem;
           border: 0; background: #2f6f4f; color: #fff; cursor: pointer; }}
  button[disabled] {{ opacity: .45; cursor: default; }}
  p.note {{ opacity: .7; font-size: .9rem; }}
  a {{ color: inherit; }}
</style>
</head>
<body>
<h1>{server_name}</h1>
<div class="state {tone}"><strong>{headline}</strong><br>{detail}</div>

<dl>
{facts}</dl>

{action}

<p class="note">The server stops itself after {idle} minutes with nobody
connected. Starting it again takes about two minutes.
<a href="?t={token}">Refresh</a></p>
</body>
</html>
"""


def _find_instance():
    response = ec2.describe_instances(
        Filters=[
            {"Name": "tag:Application", "Values": ["palworld"]},
            {
                "Name": "instance-state-name",
                "Values": ["pending", "running", "stopping", "stopped"],
            },
        ]
    )
    for reservation in response["Reservations"]:
        for instance in reservation["Instances"]:
            return instance
    return None


def _duration(delta):
    """A rough human span. Deliberately one unit: nobody needs 2h 14m 6s here."""
    seconds = max(int(delta.total_seconds()), 0)
    if seconds < 45:
        return "a few seconds"
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{minutes} minute" + ("" if minutes == 1 else "s")
    hours = round(minutes / 60)
    if hours < 24:
        return f"{hours} hour" + ("" if hours == 1 else "s")
    days = round(hours / 24)
    return f"{days} day" + ("" if days == 1 else "s")


def _player_datapoints(instance_id, now):
    """Player counts for the current run, oldest first. Empty while booting."""
    try:
        response = cloudwatch.get_metric_statistics(
            Namespace=METRIC_NAMESPACE,
            MetricName=METRIC_NAME,
            Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
            StartTime=now - timedelta(minutes=METRIC_LOOKBACK_MINUTES),
            EndTime=now,
            Period=60,
            Statistics=["Maximum"],
        )
    except ClientError as error:
        # The page is more useful degraded than not at all, so fall back to
        # reporting instance state alone.
        print(f"could not read {METRIC_NAME}: {error}")
        return []
    return sorted(response["Datapoints"], key=lambda point: point["Timestamp"])


def _trailing_empty_minutes(datapoints):
    """Consecutive zero readings at the end, which tracks the on-instance counter.

    idle-check.sh keeps the real count in /run and does not publish it. Counting
    back through the metric reconstructs it closely enough to tell a player how
    long they have, and it errs low when a publish was missed, which is the safe
    direction.
    """
    minutes = 0
    for point in reversed(datapoints):
        if point["Maximum"] != 0:
            break
        minutes += 1
    return minutes


def _stopped_since(instance, now):
    """How long the box has been asleep, from the state transition reason.

    EC2 gives this as free text, 'User initiated (2026-07-31 06:49:36 GMT)', and
    only for a recent transition. LaunchTime is no help because it refers to the
    previous run. Returns None when there is nothing parseable, and the page just
    omits the row.
    """
    reason = instance.get("StateTransitionReason", "")
    if "(" not in reason or ")" not in reason:
        return None
    stamp = reason[reason.index("(") + 1 : reason.rindex(")")].strip()
    stamp = stamp.removesuffix(" GMT")
    try:
        when = datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return now - when


def _render(headline, detail, facts=(), action="", tone="", refresh=False):
    rows = "".join(
        f"  <dt>{html.escape(label)}</dt><dd>{html.escape(value)}</dd>\n"
        for label, value in facts
    )
    meta = (
        f'<meta http-equiv="refresh" content="{REFRESH_SECONDS}; '
        f'url=?t={html.escape(ACCESS_TOKEN)}">\n'
        if refresh
        else ""
    )
    return {
        "statusCode": 200,
        "headers": {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"},
        "body": PAGE.format(
            server_name=html.escape(SERVER_NAME),
            headline=html.escape(headline),
            detail=html.escape(detail),
            facts=rows,
            idle=IDLE_MINUTES,
            token=html.escape(ACCESS_TOKEN),
            action=action,
            tone=tone,
            refresh=meta,
        ),
    }


def _connection_facts():
    return [
        ("Join via", CONNECT_ADDRESS),
        ("Password", SERVER_PASSWORD or "none"),
    ]


def _booting_page(elapsed, already_running):
    """Shown from the moment the button is pressed until the game answers."""
    facts = _connection_facts()
    if elapsed is not None:
        facts.append(("Starting for", _duration(elapsed)))

    if elapsed is not None and elapsed > timedelta(minutes=SLOW_BOOT_MINUTES):
        detail = (
            "Longer than a usual start. A first boot installs Docker and pulls a "
            "5.4 GB image, which takes about ten minutes."
        )
    elif already_running:
        detail = "Already on its way up. Nothing more to press."
    else:
        detail = "Give it about two minutes, then join from the game."

    return _render(
        "Starting up",
        detail,
        facts,
        '<button disabled>Starting…</button>',
        tone="busy",
        refresh=True,
    )


def handler(event, context):
    params = event.get("queryStringParameters") or {}

    if params.get("t") != ACCESS_TOKEN:
        # Deliberately vague, and identical for a missing or wrong token.
        return {
            "statusCode": 404,
            "headers": {"content-type": "text/plain; charset=utf-8"},
            "body": "Not found\n",
        }

    now = datetime.now(timezone.utc)
    instance = _find_instance()
    if instance is None:
        return _render(
            "No server found",
            "Nothing in this account is tagged Application=palworld.",
        )

    state = instance["State"]["Name"]
    start_button = (
        f'<form method="GET"><input type="hidden" name="t" value="{html.escape(ACCESS_TOKEN)}">'
        '<input type="hidden" name="start" value="1">'
        '<button type="submit">Start the server</button></form>'
    )

    if params.get("start") == "1" and state == "stopped":
        try:
            ec2.start_instances(InstanceIds=[instance["InstanceId"]])
        except ClientError as error:
            # Two people pressing at once, or a start that landed between the
            # describe above and here. Either way it is on its way up.
            print(f"start_instances refused: {error}")
            return _booting_page(None, already_running=True)
        # LaunchTime in the response above belongs to the previous run, so the
        # only honest elapsed time here is zero.
        return _booting_page(timedelta(0), already_running=False)

    if state == "pending":
        # Somebody has already pressed the button, or wake-on-connect fired.
        return _booting_page(now - instance["LaunchTime"], already_running=True)

    if state in ("stopping", "shutting-down"):
        return _render(
            "Going to sleep",
            "It is saving and shutting down. Wait for that to finish, then start "
            "it again.",
            _connection_facts(),
            tone="busy",
            refresh=True,
        )

    if state == "stopped":
        facts = _connection_facts()
        asleep = _stopped_since(instance, now)
        if asleep is not None:
            facts.append(("Asleep for", _duration(asleep)))
        return _render(
            "Asleep",
            "Press the button and wait about two minutes.",
            facts,
            start_button,
            tone="",
        )

    if state != "running":
        return _render(state.capitalize(), "Mid-transition. Reload in a few seconds.")

    # Running. Whether it is joinable is a separate question, answered by the
    # metric: the game does not accept players for a good while after boot.
    uptime = now - instance["LaunchTime"]
    datapoints = _player_datapoints(instance["InstanceId"], now)
    latest = datapoints[-1] if datapoints else None
    ready = latest is not None and now - latest["Timestamp"] < timedelta(
        minutes=READY_WINDOW_MINUTES
    )

    if not ready:
        if uptime > timedelta(minutes=BOOT_GRACE_MINUTES):
            # Past the grace period a silent server is not a slow boot. This is
            # the same call the watchdog makes, and it stops the box shortly.
            return _render(
                "Not responding",
                "The machine is on but the game is not answering. It gets shut "
                "down automatically, and then you can start it again.",
                _connection_facts() + [("Running for", _duration(uptime))],
                tone="busy",
                refresh=True,
            )
        return _booting_page(uptime, already_running=True)

    players = int(latest["Maximum"])
    facts = _connection_facts() + [("Awake for", _duration(uptime))]
    facts.append(("Players", str(players)))

    if players > 0:
        detail = "Join from the game whenever you like."
    else:
        left = IDLE_MINUTES - _trailing_empty_minutes(datapoints)
        if left >= 1:
            detail = (
                f"Nobody is connected. It goes to sleep in about {left} minute"
                f"{'' if left == 1 else 's'} unless someone joins."
            )
        else:
            detail = "Nobody is connected, and it is about to go to sleep."

    return _render("Awake", detail, facts, tone="ready")
