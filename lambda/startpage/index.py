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

A wake can also be queued. EC2 rejects StartInstances while an instance is
stopping, so somebody who arrives during a shutdown otherwise has to sit and
retry the button until it takes. Queuing carries the intent in the query string
of the reload this page already performs while the server is in transition, so
the flag riding along on those reloads is the entire mechanism — no state is
stored anywhere. It therefore lasts exactly as long as the tab stays open, which
matches what it is for: somebody watching the page who wants to play as soon as
the box frees up.
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
<a href="{self_link}">Refresh</a></p>
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


def _self_link(queue):
    """This page's own URL. Carrying `queue` here is what makes a queue persist.

    Both the auto-reload and the manual Refresh link go through this, so a queued
    wake survives either one and is dropped the moment a page stops asking for it.
    """
    link = f"?t={ACCESS_TOKEN}"
    if queue:
        link += "&queue=1"
    return link


def _form(label, **fields):
    """A submit button as a GET form, so the page needs no JavaScript at all."""
    hidden = "".join(
        f'<input type="hidden" name="{html.escape(name)}" value="{html.escape(value)}">'
        for name, value in fields.items()
    )
    return (
        f'<form method="GET">{hidden}'
        f'<button type="submit">{html.escape(label)}</button></form>'
    )


def _render(headline, detail, facts=(), action="", tone="", refresh=False, queue=False):
    rows = "".join(
        f"  <dt>{html.escape(label)}</dt><dd>{html.escape(value)}</dd>\n"
        for label, value in facts
    )
    link = html.escape(_self_link(queue))
    meta = (
        f'<meta http-equiv="refresh" content="{REFRESH_SECONDS}; url={link}">\n'
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
            self_link=link,
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


def _queued_page(detail, facts):
    """A wake is wanted but cannot be requested yet, so the reload will do it.

    Reached from either state that has to end in a stop before a start can go
    through: a shutdown already under way, and a running box whose game is not
    answering, which the watchdog will stop within a few minutes. Both converge on
    'stopped', and the reload carrying queue=1 is what presses the button there.
    """
    return _render(
        "Wake queued",
        detail,
        list(facts) + [("Queued", "yes, waiting for the shutdown to finish")],
        "<button disabled>Wake queued…</button>",
        tone="busy",
        refresh=True,
        queue=True,
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
    queued = params.get("queue") == "1"
    start_button = _form("Start the server", t=ACCESS_TOKEN, start="1")
    queue_button = _form("Start it again when it finishes", t=ACCESS_TOKEN, queue="1")

    # A pressed button and an arriving queue are the same request once the box is
    # actually stopped. The queue simply took a reload or two to get here.
    if state == "stopped" and (params.get("start") == "1" or queued):
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
        if queued:
            return _queued_page(
                "It is still saving and shutting down. This page will start it "
                "the moment that finishes, usually within a minute. Leave the tab "
                "open.",
                _connection_facts(),
            )
        return _render(
            "Going to sleep",
            "It is saving and shutting down, and cannot be started until that "
            "finishes. Queue a start and this page will press the button for you "
            "as soon as it is allowed.",
            _connection_facts(),
            queue_button,
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
            facts = _connection_facts() + [("Running for", _duration(uptime))]
            if queued:
                return _queued_page(
                    "The game still is not answering. The watchdog stops the "
                    "machine within a few minutes, and this page will start it "
                    "again once that is done. Leave the tab open.",
                    facts,
                )
            return _render(
                "Not responding",
                "The machine is on but the game is not answering. It gets shut "
                "down automatically within a few minutes. Queue a start and this "
                "page will bring it back once that has happened.",
                facts,
                queue_button,
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
