# Durable ingress capture and import (D03)

D03 implements FS-local durable capture, independent live discovery, PostgreSQL
import and import acknowledgement. It does **not** admit a customer to a queue.
`FREESWITCH_INGRESS_ENABLED=false` is the default. With capture enabled, the
product still returns `503 Admission unavailable` before answer/audio. D04 owns
queue/capacity admission, its acknowledgement, waiting audio and lifecycle
classification. I01–I05 retain integrated/browser/provider/load/enablement gates.
A durable capture receipt is storage evidence, never media authorization.
[D04](inbound-queue-admission.md) now provides the staged queue coordinator and
post-commit receipt/waiting continuation. It requires an explicitly injected C03
executor; the default capture/import bootstrap still does not activate admission.

## Capture and acknowledgement protocol

The repo-owned `infra/freeswitch/templates/inbound/outbound-ingress.lua` runs after
D02's actual transport-peer/DID checks and native pre-admission/trunk guards.
FreeSWITCH supplies its own UUID; the journal agent obtains original microsecond
arrival and the internally set route tags using its **own fresh** `uuid_dump`.
Caller-supplied SIP headers cannot supply those fields. The route carries number,
campaign, queue, number/queue revisions, timeout and a bounded base64url queue
configuration snapshot. Existing call rows or an API ESL subscription are not
prerequisites for capture.

A separate Node process commits SQLite with `journal_mode=DELETE`,
`synchronous=FULL`, `busy_timeout=100ms` and a maximum of 2048 database pages
(default 4096 bytes: 8 MiB). It returns exactly `stored:<uuid>` only after commit.
New captures expire 750ms after original arrival, checked before mutation and
before commit. Duplicate captured identities keep their original arrival/route.
ESL verification has a 300ms absolute command deadline; FS curl connect/total
limits are one second each. Native D02 guards bound the overall pre-admission
channel to three seconds. No synchronous FS SQLite calls are used.

After a receipt the Lua hook attempts terminal capture at hangup. The independent
agent requires a definite native `uuid_exists=false` before recording inferred
termination. A failed hook, lost API subscription, absent PostgreSQL or API crash
leaves the original capture retained for discovery. A timeout, error or unknown
ESL response is never absence proof. Inferred terminal time is the observation
time, not an invented CDR hangup time/cause; reason is
`channel_absent_on_recovery`. There are no customer originate commands in D03,
so the fixed inbound channel cannot later appear from a delayed D03 sender.

The API reconciler starts from journal records, including identities without
`calls` rows, and independently scans native `show channels as json` followed by
fresh tagged-channel dumps. It rechecks disappearance during a dump race.
Discovery cannot manufacture an old missing receipt outside its capture window.
Terminal records are processed first. A live snapshot never revives terminal
history. Initial tagged ingress events return before generic handlers that assume
a persisted product call; the periodic importer handles their durable evidence.
The staged D04 adapter extends this boundary for admitted lifecycle events.

`importIngressRecord` makes one `calls.id = ingress UUID` and one B04
`inbound_ingress_evidence` row. It uses admission advisory lock `(72202,0)`, then
campaign/evidence/call locks, with 500ms lock and 1500ms statement limits. It
performs no ESL/journal I/O or media operations while holding SQL locks. The
admission migration marker is intentionally not a history-import prerequisite:
this transaction creates no slots, queue/capacity claims or commands. Live import
uses `received`; terminal-only import uses terminal `failed` history with no
agent connection, offers, participants, originate, playback or fallback.

A PostgreSQL COMMIT precedes journal `/ack`. ACKs compare the exact sequence;
a delayed live ACK cannot acknowledge newer terminal evidence. A lost post-commit
ACK causes replay, not another call/deadline. Live receipts remain reserved even
when imported. Only terminal receipts acknowledged at their current sequence
can recycle. No TTL or import failure evicts captured work. B04 monotonic guards
and migration 035 preserve terminal state and immutable capture snapshots.

## Published configuration retention

Before exposing an enabled route to FS, the D02 publisher now commits its
`inbound_ingress_route_snapshots` entry. This also covers a crash after reload but
before the applied-revision SQL commit. Its queue/campaign foreign key prevents
removing/reparenting a queue still needed by an unimported capture. Timeout/flow
edits remain possible; the old internally tagged snapshot and deadline survive.
The renderer hash includes the Lua continuation. Published snapshots cannot be
updated/deleted by ordinary CRUD. F01 must report these reference conflicts and
use disable/versioning; H04 owns explicit safe archival/drain/retention. Do not
remove these references by time or because the current routing was disabled.

## Local transport and deployment contract

The existing API image also supplies the `ingress-journal` Compose service. It is
independent of API/PostgreSQL, has no database credentials, uses the existing FS
ESL secret only inside its own socket client, and binds capture requests only on
`127.0.0.1:18093`. There are no new published ports or firewall changes. The
loopback endpoint allows capture, terminal verification and pending-admission
polling; it cannot read the spool or ACK imports. Every capture is validated
against the actual internal FS channel, not request metadata.

Spool listing, discovery and ACK use the shared Unix socket, mode `0600`, in a
`0700` directory. SQLite is `0600`. API and journal currently share the image's
root identity; changing their users requires matching volume/socket ownership.
The journal launcher holds OS `flock` across stale socket removal and the daemon
lifetime. A second process cannot take over by TTL. The volume `ingress_journal`
must survive API, daemon and FS restarts. Do not delete it to clear an alarm.

| Variable                           | Default and meaning                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `FREESWITCH_INGRESS_ENABLED`       | `false`; enables capture/periodic import only, not queue admission                                      |
| `FREESWITCH_INGRESS_SOCKET`        | `/var/lib/outbound-dialer/ingress/agent.sock`; API and journal must agree and use the mounted directory |
| `FREESWITCH_INGRESS_JOURNAL_SLOTS` | `128`; integer 1–128, read by the independent journal; tests use two                                    |

Use `.env.example`, Compose and `scripts/deploy.sh`; no alternate deployment path
is introduced. Node 22.13+ is required for flag-free `node:sqlite`; the existing
Node 22 API image supplies it. This work changes sources only and does not deploy
or enable anything. The staged D04 coordinator supplies queue commit/admission ACK and concrete
terminal cleanup under common admission/C03 before advancing `received` calls;
the D03 importer fails closed for an admitted state it does not own.

Reserve at least 20 MiB for SQLite plus its transient rollback journal and
filesystem headroom; `max_page_count` bounds database pages, not the containing
volume. Each record has a 4096-character route-data cap, the journal has at most
128 identities and the control response is capped at 1 MiB. Capture requests
are UUID-only with 256-byte bodies, at most eight sockets, finite HTTP limits and
one concurrent verification/mutation. Overload explicitly refuses new capture;
reads remain available while ESL verification waits. DB transactions never wait
for journal/ESL and the importer coalesces work rather than allocating a worker
or SQL connection per pending channel.

## Operations and loss boundary

Metrics expose used/capacity/pending slots, oldest unacknowledged arrival,
agent-lifetime request failures and API import failures. `IngressJournalFull`,
`IngressCaptureFailures`, `IngressImportFailures` and `IngressImportLag` rules
report exhaustion, storage/terminal-capture failures and failed/lagging imports.
An independent status poll detects socket failures and stale samples even when
the importer is blocked. Compare `IngressJournalUnavailable` with
`IngressImportStale`. Pending age uses the capture or terminal update timestamp.
See [Inbound Observability and Recovery](runbooks/inbound-observability.md).
Acknowledged terminal records retained for recycling do not count as occupied.
Fixed error messages exclude caller data, secrets and request bodies. Never send
secrets via `mod_curl`: pinned upstream logs POST data and appended headers at
DEBUG ([source](https://github.com/signalwire/freeswitch/blob/v1.10.12/src/mod/applications/mod_curl/mod_curl.c)).

On an alarm, preserve spool and runtime evidence first; inspect service health,
filesystem space/permissions and ESL reachability. Restore the failed dependency
under authorized operational scope and let import replay. Acknowledged terminal
receipts can recycle; unresolved/live entries cannot. A permanently incompatible
snapshot remains retained with an import error for investigation. Do not infer
provider delivery, billing or answer from a capture/import receipt.

Attempts rejected before durable capture have **no guaranteed product history**.
Already captured work survives tested process/DB/FS restarts with the volume
intact. Lost/corrupt media, host power-loss hardware guarantees, filesystem
rollback and a DB restore older than recycled acknowledgements are outside this
guarantee. H04 must coordinate spool and DB restore/retention. I04.5 retains exact
provider retry/failover/refusal observations; local SIP 503 timing is not P proof.

## Verification

```bash
npm run test:ingress:freeswitch
npm run test:inbound:db:isolated
npm run quality
APP_ENV_FILE="$(pwd)/.env.example" docker compose --env-file .env.example \
  -f infra/docker/docker-compose.yml config --quiet
git diff --check
```

The FS runner uses product entrypoint/templates/Lua, a **separate journal process**
and actual product migrations/importer. It publishes no ports, reads no `.env`,
uses no application database, and reaches no provider. Its artifacts include
source hashes, pinned image/version evidence, native commands, report, SQLite,
SIP results and disposable-container cleanup under `/tmp/outbound-d03.*`.
The importer is SIGKILLed at actual pre-INSERT/post-COMMIT checkpoints. Faults
include agent SIGKILL/restart, full slots, SQLite write lock, SIGSTOP, real DB
stop/start and abrupt FS kill/restart. Unit tests additionally force SQLITE_FULL
and negative transport/authority cases. DB tests cover both live/terminal commit
orders with `pg_blocking_pids`, immutable microseconds/deadline, upgrade and
published queue retention. Issue #23 records actual commands, results and final
artifact locations. Planned commands here are not evidence of a passing run.
