# palworld-aws-optimized

A Palworld dedicated server on AWS that sleeps when nobody is playing. It runs
Pocketpair's official container image on EC2, keeps your world on a volume that
survives everything, and costs somewhere around $7 a month if you play a few
evenings a week.

No domain and no static IP needed. Players find it by name in Palworld's own server
browser, which also means PS5 and Xbox players can join.

Infrastructure is AWS CDK in TypeScript. You edit one config file and run one
script.

## Why it is cheap

The server [stops itself after 20 minutes](#how-the-timeout-works) with nobody
connected, and you pay for compute only while people are actually on. Leaving the
same box running around the clock would cost roughly $34 a month.

At about 20 hours of play per week, on the defaults:

| | |
|---|---|
| Compute, t3.medium, ~87 hours | $3.60 |
| Storage, 30 GB root plus 4 GB saves | $2.72 |
| Public IPv4, only while running | $0.45 |
| Backups, Lambda, CloudWatch | $0.15 |
| **Total** | **about $7/month** |

Turning on [enhanced monitoring](#enhanced-monitoring-optional) adds roughly $2, and
switching to an [Elastic IP](#elastic-ip) adds $3.60.

### The free tier will not work

Pocketpair ask for 16 GB of RAM and note that 8 GB "is also bootable, but increases
the possibility of server crashes due to out of memory". A free-tier t3.micro gives
you 1 GB. The server is x86 only, with no ARM build, which rules out the cheaper
Graviton instances too. This stack defaults to 4 GB and leans on swap plus frequent
backups to make that survivable.

## Getting started

You need [Node 18 or newer](https://nodejs.org/en/download) and an
[AWS account](https://portal.aws.amazon.com/billing/signup).

Sign in however you normally do. Everything here uses the AWS CLI's own credential
chain, so an existing profile or SSO session already works:

```bash
aws configure                 # or: aws sso login --profile my-account
```

Then:

```bash
git clone https://github.com/MattSchwabby/palworld-aws-optimized
cd palworld-aws-optimized
npm install

cp lib/config.ts lib/config.local.ts
echo "PALWORLD_CONFIG=lib/config.local.ts" > .env
```

Open `lib/config.local.ts` and replace every `<PLACEHOLDER>`: a server name, a
password, and a token for the [start page](#waking-the-server).

Out of the box that gives you a server players find by name in Palworld's own
Community Servers browser, with no domain and no fixed IP to pay for. Make the name
distinctive, because players search for it exactly.

```bash
npx cdk bootstrap     # once per account and region
scripts/deploy.sh
```

First boot takes about ten minutes, because it installs Docker and pulls a 5.4 GB
image. Later starts take about two. When it finishes, `scripts/how-to-connect.sh`
prints the server name, the password, and how to join.

### If you have more than one AWS account

Some tooling sets `AWS_PROFILE` or `AWS_SESSION_TOKEN` in your shell, and that can
send a deploy somewhere you did not intend. Two things help.

Put explicit keys in `.env`. They clear the inherited values and always win. See
`.env.example` for all three credential options.

Then fill in `account` with your 12-digit account ID rather than leaving it empty.
The CDK CLI refuses to deploy when your credentials resolve to a different account,
so a mistake fails immediately instead of building a server in the wrong place.

## Three ways players reach the server

Set `addressing` in your config. Pick before your first deploy, because changing it
later changes how players reach you.

| Mode | Extra cost | Needs | Wakes on its own |
|---|---|---|---|
| `server-list` (default) | nothing | nothing | no |
| `elastic-ip` | $3.60/mo | nothing | no |
| `route53` | ~$0.50/mo | a domain you own | yes, for PC players |

### server-list, the default

The server registers itself in Palworld's Community Servers browser and players find
it by searching your `serverName`. Nothing is allocated, so there is no address to
pay for and no DNS to configure. A changing public IP stops mattering, because the
server re-advertises itself every time it starts.

Make `serverName` distinctive. Players search for it by exact name, and the browser
only returns the first 200 matches, so anything generic buries itself.

This mode requires `communityServer.enabled`, which is also the default. The config
check refuses to deploy without it, since the server would have no address and no
listing, leaving nobody able to reach it.

Being listed means anyone can see your server exists. Your `serverPassword` is the
only thing stopping them joining, so set one.

### elastic-ip

A fixed numeric address that never changes, for a private group who would rather
type an address than appear in a public browser. Costs about $3.60/month, because a
public IPv4 bills hourly whether the instance runs or not.

Players paste `<ip>:8211` into Join Multiplayer Game. Consoles cannot do this, so
pair it with `communityServer.enabled` if anyone plays on PS5 or Xbox.

### route53

Costs less and wakes on its own, at the price of needing a domain you control.

A player's game looks up your hostname before it connects. Route 53 logs that
lookup, and the log entry starts the server. Nobody has to press anything.

You delegate one subdomain, say `palworld.yourdomain.com`, by adding NS records
wherever your DNS lives now. Everything else in your domain keeps working, because
delegation covers only the label you delegate. Your website and your email are not
involved.

Deploy first, because the nameservers do not exist until the hosted zone does. Then:

```bash
scripts/show-nameservers.sh       # prints the exact records to add
scripts/sync-cloudflare-ns.sh     # or this, if your DNS is on Cloudflare
```

You add four records, all the same type and name, one per nameserver. Route 53 gives
you a different set each time a zone is created, so use what the script prints
rather than copying these:

| Type | Name | Value | TTL |
|---|---|---|---|
| NS | `palworld` | `ns-161.awsdns-20.com` | 300 |
| NS | `palworld` | `ns-569.awsdns-07.net` | 300 |
| NS | `palworld` | `ns-1369.awsdns-43.org` | 300 |
| NS | `palworld` | `ns-1544.awsdns-01.co.uk` | 300 |

Some registrars want the label on its own, `palworld`, and others want the whole
thing, `palworld.yourdomain.com`. On Cloudflare make sure the records are DNS only
rather than proxied, though NS records cannot be proxied anyway.

Check it took:

```bash
dig NS palworld.yourdomain.com +short
```

The first connection attempt always fails. That attempt is what wakes the server.
Wait about two minutes and join again.

Only PC players get this. Consoles never make a lookup you can watch, so they still
need the [start page](#waking-the-server).

Worth knowing: anything that resolves the name starts the server, including DNS
scanners and uptime monitors. A spurious wake costs about 1.4 cents and then the
server sleeps again, so it is self-limiting. Keep an eye on the Wake on connect
graph in the dashboard if you suspect something is polling you.

### Switching between them later

Edit `addressing`, then run `scripts/deploy.sh`. The change only takes effect on that
deploy. Your world is never at risk, since the save volume is not involved, but how
players reach you does change, so tell them first.

Moving **to** `route53` creates a hosted zone. Deploy, then run
`scripts/show-nameservers.sh` and add the NS records, because the name will not
resolve until you do.

Moving **away from** `route53` deletes the hosted zone. Remove the NS records at your
registrar afterwards, since they now point at a zone that no longer exists.

Moving **to** `elastic-ip` allocates an address and starts the $3.60/month charge.
Moving away releases it, and players need the new `ConnectAddress`.

Every direction leaves the instance and its disks alone.

## Waking the server

A sleeping server has to be started by something. In `route53` mode a joining PC
player's DNS lookup does it. Otherwise, and for consoles in every mode, it is the
start page.

The start page is on by default in every addressing mode. It is a small web page
with one button, served by a Lambda Function URL. The link comes out as
`StartPageUrl` after a deploy and looks like
`https://xyz.lambda-url.us-west-2.on.aws/?t=your-token`. Send it to whoever plays
with you. It reports what the server is doing and starts it if it is asleep.

| What you see | What it means |
|---|---|
| **Awake**, with a player count | Joinable now. When nobody is on it also says how long until it sleeps. |
| **Starting up**, with elapsed time | On its way. Past four minutes it says why a first boot takes ten. |
| **Asleep**, with how long | Nothing running. This is the one state with a button. |
| **Going to sleep** | Mid-shutdown. Wait for it to finish, then start it again. |
| **Not responding** | The box is up but the game is not answering, past `bootGraceMinutes`. The watchdog stops it shortly. |

## Connecting to the server

In Palworld, choose **Join Multiplayer Game**, then **Community Servers**, search your
exact `serverName`, and enter the password. That is the same on PC, PS5, and Xbox.

On `elastic-ip` or `route53`, PC players can instead type the address into the field
at the bottom of Join Multiplayer Game. Always include the port: Palworld will not
connect to a bare hostname, and it ignores SRV records.

## How the timeout works

`idle-check.sh` runs on the instance once a minute. It asks the game's local REST
API how many players are connected and publishes that number to CloudWatch.

Twenty consecutive readings of zero and the server saves the world, uploads a
backup, stops the container, then stops the instance. One player connecting resets
the count to zero.

When the API does not answer, which happens while the game is still starting, the
counter is left alone rather than incremented. Unknown is treated differently from
empty, so a slow start cannot shut the server down mid-boot. The counter lives in
`/run`, so every boot begins at zero.

Change it with `idleShutdownMinutes`. Ten is aggressive, sixty is forgiving. The
cost difference is pennies. What you actually risk by going short is shutting down
while somebody reconnects after a drop, which sends them through the two-minute wake
again.

Two other numbers sit alongside it and the order matters:

- `hardStopMinutes`, default 35, is when a Lambda gives up and stops the instance
  bluntly. Keep it well above `idleShutdownMinutes` or the blunt stop wins the race
  and you lose the final save. The config check refuses to deploy if you get this
  backwards.
- `bootGraceMinutes`, default 25, is how long a freshly started instance is left
  alone. Do not set it below your cold boot time.

That Lambda exists because the on-instance check can fail. A wedged agent, a crashed
game, a bad deploy: any of those leave a box running with nobody on it, billing all
month.

## When a deploy restarts your server

Most deploys are invisible to players. It depends on which resource changed.

| What you changed | What happens |
|---|---|
| Server name, password, idle timeout, image tag, backup settings, anything in `server/` | Nothing. Applied at the next boot. |
| Dashboard, Lambdas, IAM, alarms, S3 lifecycle | Nothing. The instance is not touched. |
| `instanceType` | CloudFormation stops the instance to change it, then starts it. Players drop. The shutdown is graceful so no progress is lost. |
| The instance's startup script, which lives in `lib/palworld-server-stack.ts` and only changes if you edit that file | Same as above, and for the same reason. |
| The AMI, after `cdk context --clear` | Full replacement. New instance, root volume discarded, save volume detached and reattached. |

Runtime settings are published to SSM Parameter Store, and the instance reads them
when it boots. A running server keeps whatever it started with. Nothing gets swapped
out underneath your players.

### Applying config without waiting

```bash
scripts/apply-config.sh
```

This re-runs the bootstrap in place. It re-reads SSM, re-downloads `server/`,
rewrites the game's settings file, and restarts the container. Anyone connected gets
dropped, though the restart is graceful so nothing is lost. On a sleeping server it
does nothing, because the next wake picks the changes up anyway.

## Not losing your world

Four layers, because Pocketpair warn that running short on memory corrupts saves.

Save data lives on its own EBS volume, separate from the root disk, marked to
survive deletion. Destroying the stack or replacing the instance leaves it alone.

Stopping is not the same as terminating. Idle shutdown stops the instance and both
volumes persist untouched.

Timestamped archives go to S3 every 15 minutes and again on every shutdown, with the
20 most recent kept. This is the layer that covers corruption, which a volume would
faithfully preserve.

A 4 GB swap file means the server overshooting its RAM gets slow instead of getting
killed. That gives it 8 GB to address in total, which is the floor Pocketpair call
bootable.

Every shutdown path saves through the REST API first, then backs up, then stops the
container. A clean stop loses nothing.

### Restoring an older save

```bash
scripts/restore-backup.sh                                  # list what you have
scripts/restore-backup.sh palworld-20260731T064936Z.tar.gz # restore one
```

It asks you to type the archive name again, and it backs up the current world before
overwriting anything, so a restore you did not mean to run is itself reversible. The
instance has to be running.

On a genuinely empty save volume the bootstrap restores the newest backup on its
own. You only need this to go back to a specific point.

## Monitoring

A CloudWatch dashboard called Palworld comes with every deploy. CloudWatch includes
three custom dashboards free and this is one of them, built only from metrics that
already exist, so it adds nothing to your bill. Sharing a dashboard publicly does
start billing GetMetricData calls, so avoid that.

It graphs player count, CPU, network, save volume I/O, backup count and size, and
Lambda invocations and errors. Gaps everywhere mean the server is asleep, which is
the normal state. An instance that is running while the player count is missing is
an unhealthy game server.

That last reading is the one the [start page](#waking-the-server) turns into a
sentence, so a player who asks whether the server is up does not need the console or
an AWS login. Send them the link rather than a dashboard.

### Enhanced monitoring, optional

Off unless you switch it on, because it is the one part of this stack that costs
money where the rest does not. Roughly $2 a month: custom metrics are $0.30 each,
alarms $0.10 each, log ingestion $0.50 per GB.

Turn it on if you run 4 GB. A memory alarm is the only warning you get before an
out-of-memory kill, and an out-of-memory kill is how saves get corrupted.

**Switching it on:**

```ts
// lib/config.local.ts
enhancedMonitoring: {
  enabled: true,
  alertEmail: 'you@example.com',   // '' creates the alarms with no email
  memoryAlarmPercent: 85,
  swapAlarmPercent: 50,
  diskAlarmPercent: 85,
  logRetentionDays: 14,
}
```

```bash
scripts/deploy.sh          # adds the PalworldMonitoring stack
scripts/apply-config.sh    # only if the server is running right now
```

The agent gets installed by the bootstrap, so a sleeping server picks it up on its
next wake and `apply-config.sh` is unnecessary. Confirm the subscription email AWS
sends you, otherwise the alarms fire into nothing.

You get memory, swap, and disk metrics, which EC2 does not publish on its own, plus
two extra dashboard widgets showing them. Server logs and bootstrap logs ship to
CloudWatch continuously. Six alarms cover memory, swap, disk, EC2 status checks,
watchdog failures, and a server that is running but not answering.

Logs ship continuously rather than at shutdown for a specific reason: a hard
out-of-memory kill skips the graceful stop, so anything written only on the way out
would be missing in exactly the case you care about.

**Switching it back off:**

```ts
enhancedMonitoring: { enabled: false, /* ... */ }
```

```bash
npx cdk destroy PalworldMonitoring    # do this first
scripts/deploy.sh
```

That destroy is not optional and it is easy to miss. Setting `enabled: false` drops
the stack out of the CDK app, and `cdk deploy` only touches stacks the app still
defines. A stack that disappears from your code stays deployed, and its alarms keep
billing, until you delete it by name.

The agent itself stops on the instance's next boot, so the metrics stop arriving
without any further action.

### Without it

Instance logs stay in journald on the box. `scripts/logs.sh` reaches them over SSM,
but only while the instance runs. Since the server stops itself when empty, and a
crash tends to be followed by a stop, the moment you most want the logs is the moment
you cannot read them. They do survive on the root volume, so starting the box and
looking works.

## Commands

Every script reads `.env` and pins AWS calls to those credentials. They unset
`AWS_PROFILE` first, so an inherited profile from other tooling cannot send your
deploy to the wrong account.

| Command | What it does |
|---|---|
| `scripts/deploy.sh` | Deploy everything, then sync DNS if you are on Cloudflare |
| `scripts/how-to-connect.sh` | Address, server name, password |
| `scripts/status.sh` | Instance state, IP, DNS record, recent player counts |
| `scripts/start.sh` | Wake the server by hand |
| `scripts/stop.sh` | Graceful shutdown now |
| `scripts/apply-config.sh` | Push config changes to a running server |
| `scripts/backups.sh` | List save archives in S3 |
| `scripts/restore-backup.sh` | Roll back to an earlier save |
| `scripts/logs.sh [bootstrap\|server\|idle\|backup\|dns]` | Pull logs without a shell |
| `scripts/connect.sh` | Shell on the instance via SSM Session Manager |
| `scripts/admin-password.sh` | Print the in-game admin password |
| `scripts/show-nameservers.sh` | NS records for delegating your subdomain |
| `scripts/sync-cloudflare-ns.sh` | Write those records for you, Cloudflare only |

`status.sh` reads the DNS record through the Route 53 API rather than resolving it,
because asking whether the server is running should not start it.

No SSH port is open and there is no key pair anywhere in this stack. Session Manager
tunnels over the instance's outbound connection, so the only inbound rule is UDP
8211 for the game.

The admin password is generated on the instance at first boot and stored only on the
save volume. It is never in this repo, never in Secrets Manager, never in a stack
output.

## Layout

```
bin/palworld.ts                  CDK app, picks which stacks to build
lib/config.ts                    The template you copy
lib/config-schema.ts             Types every config has to satisfy
lib/active-config.ts             Chooses your config, validates it
lib/assert-lf.ts                 Refuses to build on CRLF line endings
lib/metrics.ts                   Metric and log group names, shared
lib/alarm-specs.ts               Alarm thresholds, shared with the dashboard
lib/palworld-server-stack.ts     EC2, EBS, S3, addressing, watchdog, start page
lib/palworld-wake-stack.ts       us-east-1, query logging and the wake Lambda
lib/palworld-monitoring-stack.ts Optional alarms
lib/palworld-dashboard.ts        The free dashboard
lambda/wake/                     Starts the instance on a DNS lookup
lambda/backstop/                 Stops it when the on-instance check has failed
lambda/startpage/                The web start button and status page
lambda/zonecleanup/              Empties the hosted zone so teardown works
server/                          Runs on the instance, re-fetched every boot
scripts/                         Operator commands
```

`server/` ships as an S3 asset and gets re-downloaded on every boot. Edit those
scripts, deploy, and the next start picks them up with no instance replacement.

## Common tasks

### Scale up

```ts
instanceType: 'm6i.large',   // 2 vCPU, 8 GB
// instanceType: 'm6i.xlarge', // 4 vCPU, 16 GB, the official recommendation
```

Then deploy. The instance restarts and your world is untouched.

t3 instances burst, and this stack runs them with unlimited credits so play never
gets throttled. Sustained CPU above the baseline adds $0.05 per vCPU-hour. For
predictable billing use `c6a.large` instead.

### Update the game

Bump `palworldImage` to a newer tag from
[the package registry](https://github.com/pocketpairjp/palworld-dedicated-server-docker/pkgs/container/palserver),
deploy, then restart. Take a backup first.

### Tear it down

```bash
npx cdk destroy --all
```

The save volume and the backup bucket are set to survive on purpose. Delete them by
hand once you are sure.

## Gotchas

Git Bash on Windows rewrites arguments that look like absolute paths, so
`/palworld/runtime-config` becomes `C:/Program Files/Git/palworld/runtime-config` and
SSM returns a confusing ParameterNotFound. `scripts/_env.sh` sets `MSYS_NO_PATHCONV=1`
to stop that. It also sets UTF-8 output, because the AWS CLI is Python and a
non-ASCII character in a command's output will abort the call on a cp1252 console.

The AMI is pinned, resolved once and cached in `cdk.context.json`, which is
gitignored. That is deliberate. The SSM latest alias re-resolves on every deploy, so
a routine Canonical publish would silently replace your instance. Run
`cdk context --clear` when you want a newer one.

The `Application=palworld` tag is load-bearing. All three Lambdas find the instance
by it, and the IAM policies that let them start and stop it are conditioned on it.

## License

MIT. See [LICENSE](LICENSE).

Palworld and its server software belong to Pocketpair. This project only deploys
their [official container image](https://github.com/pocketpairjp/palworld-dedicated-server-docker)
and has nothing to do with them.
