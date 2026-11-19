# H01 — Staged lifecycle recovery

Issue: [H01 #38](https://github.com/sptmru/outbound-freeswitch-dialer/issues/38).
Branch: `feat/h01-lifecycle-recovery`, base `4480f2e`.
Implementation and acceptance evidence are local and uncommitted. I05 owns runtime activation.

## Composition and ownership

`lifecycleRecoveryRuntime` in [lifecycle-recovery-runtime.ts](../apps/api/src/lifecycle-recovery-runtime.ts)
composes D04 ingress, E02 connection, G02 transfer, F03/F04 fallback, C06 control
and fixed orphan cleanup using the existing reserved C03 executor. It creates no
pool, role, timer, feature flag or production bootstrap. The optional fourth
argument of `startFreeSwitchEventListener` installs it with the actual listener's
persistence barrier. I05 must supply compatible native scripts and executor pools.

Each pass drains persistence before importing D03/D04 journal and discovery
records, including identities without a first SQL row. It revisits eight calls
per batch using saved roots, immutable tokens and original deadlines. A rotating
UUID cursor prevents stuck work from starving later calls. Existing workers own
connection, transfer and fallback progression. A local guard coalesces requests;
C03 execution locks and admission locks remain the cross-process authority.
Per-call failures are returned to the caller for reporting.

The persistence ticket requires an active subscription and an empty ordered
queue. Event arrival, disconnect and overflow invalidate observations. Permanent
persistence failure disables tickets for that listener's remaining lifetime.
A reconnect cannot repair a discarded event. Native `event-plain` CUSTOM
subclasses are decoded at the wire boundary before lifecycle dispatch. A durable `inbound_captured` event wakes the optional
consumer promptly; the journal and admission checks remain authoritative.

## Switch command and producer evidence

[Migration 045](../apps/api/db/migrations/045_command_incarnation_fences.sql)
adds an opt-in `fs-fenced-v1` execution protocol, immutable operation/`core_uuid`
fences and separate SQL receipt acknowledgments. Existing unfenced attempts stay
unknown; a new lock owner, elapsed deadline or absent channel cannot resolve them.
The default C03 transport remains compatible with existing callers.

For opted-in commands, the same authenticated socket reads `core_uuid` and
`conf_dir`, arms the operation on the executor's leased database connection and
sends one fixed-`Job-UUID` frame through
[outbound-command.lua](../infra/freeswitch/templates/inbound/outbound-command.lua).
Abort or lost lock prevents a late SQL callback from sending. No SQL transaction
spans ESL. The wrapper checks the current switch incarnation, atomically claims
its job in SQLite and records the real command result before returning it.
`inspect` atomically revokes a never-started job, fencing original bytes that may
still be delayed in a socket. A changed incarnation fences all old-boot commands.
An already started job without a result remains uncertain.

Native waiting, playback and forwarding scripts also record producer state in
the receipt before publishing CUSTOM completion. Forwarding completion means the
native bridge producer returned; customer absence alone cannot establish this.
Recovery persists journal facts as `RECOVERY_NATIVE_RECEIPT`, never as invented
successful `BACKGROUND_JOB` events. Action-specific resolvers require the fixed
job plus exact leg/effect or producer completion. The live channel profile (`Unique-ID`, `Caller-Channel-Answered-Time`)
and exact bridge-peer probes can recover effects missed during an ESL outage, without changing call identity.

SQL resolution precedes receipt ACK. Revocation tombstones survive ACK for the
whole switch incarnation, because original bytes can arrive afterwards. They
are recycled after incarnation change. The journal is bounded to 256 receipts
and 2048 SQLite pages; exhaustion or storage errors fail closed and retain
uncertainty. Its file is `outbound-commands.sqlite` in the existing FreeSWITCH
`db_dir` volume. H04 backup/retention and I05 activation must include this file;
never delete it to make uncertain capacity reusable. The local drill is not
production-storage durability or power-loss proof.

## Exact cleanup and truthful outcomes

`CallExecutor.inspectCall` leases a bounded critical seat and dedicated connection,
then acquires the per-call execution lock before admission. A five-second abort
and connection-loss latch invalidate observations. A busy lock/seat defers.

`recoverQuiescentCall` refuses absence reasoning while any attempted operation is
unresolved. It probes only fixed validated UUIDs, caps the leg set at 32 and
rechecks identities/senders under admission. Changed persistence tickets roll
back the decision. Unattempted pending work can be canceled only after the
customer is absent or terminal; absence of a not-yet-originated recipient cannot
cancel a live customer's pending connection.

Confirmed absent legs receive exact participant/leg evidence. Missing customers
without a terminal fact become technical failures with `channel_absent_on_recovery`;
absence does not prove successful playback, forwarding or conversation. Existing
terminal/manual corrections, campaign, arrival and deadlines remain authoritative.
D04 discovery likewise records missing terminal evidence as failure rather than
inferring a completed conversation from an earlier connected participant.

A live orphan after customer termination receives a durable fixed-UUID C03 hangup
intent. Its slot and capacity remain occupied until the sender is resolved and
the exact channel is absent. Cleanup then releases only the original reservation
and generation. Replayed terminal facts cannot release a newer call's slot.
Unknown legacy senders or native `started` receipts remain occupied pending
stronger evidence; they are not converted into successful commands.

## Acceptance and verification boundaries

Use Node.js 22 or newer:

```bash
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN=H01 npm run test:inbound:db:isolated
npm run test:recovery:freeswitch
npm run test:ingress:freeswitch
npm run quality
git diff --check
```

The DB matrix uses real PostgreSQL, a separate recovery OS process, IPC
checkpoints, advisory locks and admission barriers. It checks stale observations,
lock loss, replay, manual correction, newer slots, unknown senders and exact
cleanup. Simulated native replies in these tests are not FreeSWITCH proof.

The recovery runtime drill uses pinned FreeSWITCH 1.10.12 and PostgreSQL 17.11,
network-none containers, no published ports, local UDP/PCMU endpoints and decoded
audio. The actual event listener owns persistence in the composed matrix; the
fixture observer supplies no synthetic lifecycle persistence. Replacement API
worker/listener processes are killed and recreated with the same database and
journal. Desk identity/verification is an explicit SQL fixture; HTTP
authentication and browser/WebRTC acceptance are separate gates.

| Criterion | Direct checks                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01.1     | Queued and connecting worker/listener restart; switching restart after physical handover; restart during playback; external dialing and connected restart; preserved original arrival/deadlines and single fixed command/leg identities; decoded RTP.                                                                                                                                               |
| H01.2     | Separate DB processes and lock/barrier schedules; stale tickets, replay and newer-slot protection; real held BGAPI bytes, terminated execution backend, native atomic revocation, SQL ACK, late original frame and observed negative BACKGROUND_JOB with no new invite; positive native originate completion with lost sender/listener responses recovered from the journal without another INVITE. |
| H01.3     | Unavailable/locked/suspended/full ingress journal, PostgreSQL stop/start; actual worker death before INSERT and after COMMIT/before journal ACK, journal process restart, ended-during-outage import; lost terminal with a live orphan and fixed cleanup; abrupt FS restart, obsolete-incarnation rejection, final zero unresolved operations/slots/capacity/native channels.                       |

The D03 regression command independently exercises capture refusal, journal
capacity/SQLite lock/suspension, DB outage and FS SIGKILL/journal restart. Composed
recovery cases and standalone ingress regression results are reported separately.
Load/soak, browser, provider, hosted CI, deployment, rollback and production
acceptance remain separate tasks. Test containers never use application `.env`,
application databases or external trunks.

## Verified local record — 2026-11-18

H01.1–H01.3 are verified at the required local DB/FS levels. This record
supersedes the earlier partial implementation handoff; I05 activation remains
separate. Base revision is `4480f2e`; changes remain local/uncommitted.

| Command                                                | Result                                                                                                                                              | Retained artifacts                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `npm run test:recovery:freeswitch`                     | PASS: 24 groups (17 H01 + 7 E02), zero unresolved operations, occupied slots, unreleased capacity or native channels                                | `/tmp/outbound-e02.7izM6nuw`                                         |
| `npm run test:ingress:freeswitch`                      | PASS: all 8 original D03 groups                                                                                                                     | `/tmp/outbound-d03.Rj8qiQiX`                                         |
| Isolated DB wrapper running `npm run quality`          | OpenAPI, lint, formatting, types and 544 API tests / zero skips PASS; whole command exited 1 during web setup with full `/tmp` and truncated output | `/tmp/outbound-inbound-db.OGH9fCnT`                                  |
| `TMPDIR=... npm --workspace @outbound-dialer/web test` | PASS: 206 tests after removing only failed H01 scratch runs and using an ignored scratch directory on the root filesystem                           | `/tmp/vscode-agent-codex-sandbox-pnhDqw/h01-web-final.log`           |
| `TMPDIR=... npm run test:ops && npm run build`         | PASS: 78 ops tests and all workspace builds, exit 0                                                                                                 | `/tmp/vscode-agent-codex-sandbox-pnhDqw/h01-quality-resume-tail.log` |
| `git diff --check`                                     | PASS                                                                                                                                                | Local worktree                                                       |

The quality wrapper is the existing isolated PostgreSQL runner with only its
repository path and final command changed; it never reads application `.env`.
Use `PATH=/tmp/node-v22.13.0-linux-x64/bin:/tmp/f02-ffmpeg:$PATH` in this environment.
The resumed steps use
`TMPDIR=/root/dev/freelance/outbound-dialer/node_modules/.cache/h01-tmp`.
Every individual quality step passed; the monolithic command is **not** reported
as a successful run. The passed API tests were not rerun to hide the storage
failure. The earlier successful broad run predates the last live-profile fix
and is not substituted for final verification.

Node 22.13.0, PostgreSQL 17.11, FreeSWITCH 1.10.12. The FS restart drill uses a
disposable PostgreSQL volume, because Docker clears tmpfs on stop/start; the
quality DB uses tmpfs and is not target-storage durability proof. Both final
source manifests match the implementation. Test containers/volumes were removed;
final evidence is retained. Only identified failed H01 debug artifacts were
removed to recover temporary space.

See [Inbound Observability and Recovery](runbooks/inbound-observability.md)
for alert response, evidence capture and a recovery scenario walk-through.
