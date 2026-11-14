# A03 — Durable Ingress Before the First Product Row

Date: 2026-11-14. [A03 / #4](https://github.com/sptmru/outbound-freeswitch-dialer/issues/4),
under [tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Branch: `prototype/a03-durable-ingress`. Base: `139c1e9c7798702f1e43621fb1bc9ebb52458c1a`.
Implementation and evidence are local; no commit, push, PR, deployment or provider call.

This is a protocol prototype for A03. It does not implement product inbound admission,
offers, migrations, capacity reservations, waiting audio or routing. Product inbound
remains disabled until the later implementation and I04/I05 acceptance gates pass.

## Selection and source review

Read AGENTS.md, searched the Developer Knowledge Base, fetched the current tracker
and task issues A01–I05, and inspected dependency statements and Dependency links.
A01 and A02 were closed; A03's only prerequisite is A02's amended local FS/R contract.
The explicit provider deferral permits isolated A03 work without I04. A03 was the
first open task by ID; immediately before the start comment it had no assignee or
comments. GitHub REST returned no open repository PRs; its timeline had issue cross
references, not a development PR. The checkout was clean before creating this branch.
The GitHub connector's PR search returned issues despite `is:pr`; REST supplied that check.

Requirements and boundaries:
[source plan section 6.1](inbound-calling-implementation-plan.md#61-recovery-before-the-first-database-insert),
[A02 contract](inbound-ingress-prototype.md), [requirements](requirements.md),
[architecture](architecture.md), [implementation status](implementation-plan.md),
[environment contract](environment-configuration.md), and [initial ADR](adr/0001-initial-architecture.md).
The imported breakdown file is absent from this checkout; GitHub #1 and #4 contain
the full tracker, dependency amendment and numbered acceptance criteria.

## Selected protocol

Use a separate FS-local journal agent with synchronous SQLite commits, followed by
an idempotent PostgreSQL importer. The agent is independent of the product API,
PostgreSQL availability, importer memory and API ESL subscription. FS performs
bounded local requests through `mod_curl`; it never performs SQLite writes itself.

1. Reuse A02's literal transport-source and validated DID/revision gate. Lua reads
   the internally assigned channel UUID and `Caller-Channel-Created-Time` from the
   in-process `uuid_dump` API. It never takes identity from caller-provided headers.
   `start_uepoch` is a finalization variable and cannot supply this live timestamp.
2. Before answer, audio or any product work, send the internal UUID/arrival to the
   journal agent. In one SQLite `BEGIN IMMEDIATE` transaction it claims a free slot
   and stores original arrival, validated DID/revision and pending terminal evidence.
   `synchronous=FULL` and `journal_mode=DELETE` establish the local storage boundary.
   Only successful COMMIT permits the exact `stored:<uuid>` receipt.
3. FS requires that receipt before marking `a03_durable=true`. Capture requests
   expire 750 ms after original arrival, checked before mutation and before commit;
   HTTP connect and total timeouts are each one second. A missing, failed, full,
   locked or stopped agent produces SIP `503` before answer, with a tested total
   rejection bound of three seconds. All these numbers are lab values for A06 review.
4. A channel-state hangup hook sends terminal evidence through the same bounded
   local protocol. This callback witnesses termination even without an API ESL
   subscriber. Final `hangup_cause`/`end_uepoch` variables may still be unset: retain
   `UNKNOWN`/zero in that case. `CoreSession:hangupCause()` can cache `NONE`, and native
   `uuid_dump` can already refuse a closing channel. Do not invent CDR details.
5. An independent importer reads retained journal evidence and read-only native FS
   UUID discovery. A definite `false` can establish that the original leg is gone;
   connection failure, timeout, or an unknown response cannot. During an ESL outage,
   keep evidence pending. Product D03 must supply trusted fresh discovery and the
   admission/revalidation rules before any offers; a snapshot here cannot authorize media.
6. Upsert into isolated `a03_calls` by ingress UUID. Original arrival, DID, revision
   and `deadline_us = arrived_us + 60000000` remain immutable. Terminal state is
   monotonic, and exact journal causes can enrich an inferred terminal record.
   Fresh processes replay both sides of the PostgreSQL commit boundary. The fixture
   table models the protocol; it is not a product migration or a full `calls` row.
7. Acknowledge only after PostgreSQL COMMIT. Keep a live slot reserved even after
   live import, since terminal evidence is still owed. Recycle only a terminal slot
   whose terminal import is acknowledged. Failure between COMMIT and acknowledgement
   causes replay, not another call or a new deadline.

After a journal-agent crash or abrupt FS restart, an admitted receipt remains on
the bind-mounted journal. A successful FS absence check permits terminal history
with `channel_absent_on_recovery`, retaining original queue age. It does not claim
an exact hangup time/cause. A late live snapshot cannot resurrect that history.
The importer has no offer, originate, playback or media-command interface.

The fixture trusts only its private loopback namespace and repo-controlled scripts.
There is no production HTTP authentication design in this prototype. Product D03
must restrict/authenticate the journal transport and protect the spool/ack interface;
do not expose this fixture listener on the product host network.

### Storage, retention and failure boundary

- Four fixed slots bound admitted, unacknowledged work. Both live and terminal
  unacknowledged evidence consume slots. There is no time-based eviction.
- Every SQLite connection sets `busy_timeout=100`, `synchronous=FULL` and
  `max_page_count=64`; the database page size is 4096 bytes. The database is capped
  at 256 KiB. DELETE-mode rollback-journal space is additional; reserve at least
  1 MiB for this lab store. Do not enable WAL or assume a database-page cap also caps logs.
- HTTP has eight connections, 512-byte capture bodies, one request per socket,
  and one-second request/header/socket limits. FS has A02's eight-session cap.
  Test inputs are fixed-size trusted metadata; these are not production budgets.
- A terminal write failure retains the admission slot. Recover from fresh FS
  discovery after the outage; never interpret a failed ESL request as absence.
- A crash/lost response around journal COMMIT can leave evidence for a caller that
  received refusal. Preserve it and classify by recovery evidence. Attempts rejected
  before durable capture, including full/unavailable storage, have **no guaranteed
  product history**. Local diagnostics are best effort. Already captured work is
  never silently discarded to make room.
- Prototype status is inspectable from SQLite slots, HTTP failures and retained
  artifacts. D03/H05 must add operational alerts for capture failures, full/high
  utilization, oldest unacknowledged age, terminal-capture failures and import lag.
  H04 must coordinate acknowledged-history backup/restore and spool retention.
- The tested guarantee covers importer/process crashes, actual PostgreSQL stop/start,
  lost API ESL delivery, agent stop/restart, and FS SIGKILL/restart with storage intact.
  It does not cover destroyed/corrupt storage, host power-loss hardware guarantees,
  filesystem rollback, or a PostgreSQL restore older than recycled acknowledgements.
  Such failures require separate backup/restore evidence and operational policy.

### Rejected alternative

Direct Lua `freeswitch.Dbh` SQLite writes passed replay tests but failed bounded
rejection. Holding a real SQLite write lock caused native `switch_core_db.c` retries
(`SQLite is BUSY, sane=...`) beyond the five-second SIP probe deadline despite
`PRAGMA busy_timeout=100`. An FS `sched_hangup` did not produce a final SIP response
while that synchronous call remained blocked. Those failed runs are not acceptance
evidence. The separate agent contains that wait; `mod_curl` gives FS its own deadline.
The final lock and SIGSTOP scenarios verify both boundaries.

Relevant pinned upstream references:
[mod_curl timeout handling](https://github.com/signalwire/freeswitch/blob/v1.10.12/src/mod/applications/mod_curl/mod_curl.c),
[channel timestamp finalization](https://github.com/signalwire/freeswitch/blob/v1.10.12/src/switch_channel.c).

## Reproduce

Prerequisites: Linux, Node.js 22.13+ with `node:sqlite`, installed npm dependencies,
Docker, `nsenter`, permission to create disposable containers and enter their network
namespace, and the two pinned images already present. Node's SQLite API may emit an
experimental warning. No populated `.env` is read.

```bash
npm run test:prototype:durable-ingress
node --test tests/a03-ingress.test.mjs
npm run quality
git diff --check
```

[Runner](../scripts/test-a03-ingress.sh) creates a network-none namespace anchor,
FS and PostgreSQL containers sharing only that namespace. There are no published
host ports or reachable providers. PostgreSQL listens on a disposable Unix socket;
its anonymous data volume survives its test restart and is removed on teardown.
The journal agent and SIP probe run as separate host Node processes inside the new
network namespace. Fault commands target only the uniquely named test containers
and journal child PID. The cleanup trap removes all three containers and the PG
volume, retaining `/tmp/outbound-a03.*/` artifacts and journal for inspection.

Images:

- FS: `safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6`,
  FreeSWITCH 1.10.12 / `a88d069d6f`, amd64.
- PG: `postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`,
  PostgreSQL 17.11 alpine. This fixture does not replace the product/CI database version.

Sources: [FS hook](../infra/freeswitch/prototypes/a03/ingress.lua),
[journal agent/importer](../scripts/a03-ingress-journal.mjs),
[FS + DB assertions](../scripts/a03-ingress-probe.mjs),
[U regressions](../tests/a03-ingress.test.mjs).
A02's helper exports now permit SIP CANCEL and diagnostic collection; its existing
default scenarios and production FreeSWITCH templates are unchanged.

## Acceptance evidence

**Status: A03.1–A03.3 complete at the required isolated FS + DB / R level.**
Final run: `npm run test:prototype:durable-ingress`, exit 0, ten scenarios;
2026-11-14 12:33 Asia/Yerevan (08:33 UTC), Node v23.7.0.
Artifacts: `/tmp/outbound-a03.MBDtc149/`, local and not uploaded to GitHub.
`report.json` SHA-256:
`3b79a0cca509667168c1285f63e67b368dc3fe5d4c1020fc58f593970ee5f865`.
`sha256sum -c /tmp/outbound-a03.MBDtc149/source-sha256.txt` passed for all six runtime sources.

| Criterion | Actual verification                                                                                                                                                                                                                        | Result                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| A03.1     | `before-insert` and `after-commit`: abort independent importer processes at both checkpoints, verify zero/one rows and no ack, restart and replay twice, compare immutable arrival/deadline; replay old live capture after terminal import | PASS; one identity per call, original queue age, terminal never resurrected                                                   |
| A03.2     | `terminal-first` and `discovery-first`: stop actual PostgreSQL, close API ESL, caller sends SIP CANCEL; journal hook records termination independently; restart DB/importer and replay both orderings                                      | PASS; one terminal row per call, original deadline, no answer/RTP or new media work                                           |
| A03.3     | Abrupt FS SIGKILL/restart, agent SIGSTOP/SIGKILL/restart with retained live receipt and lost terminal capture, four-slot exhaustion, real SQLite write lock, stopped agent and unavailable listener                                        | PASS; captured identities survive, absent legs import terminal with explicit uncertainty; refusal bounded below three seconds |

All ten admitted synthetic ingress calls finished as ten unique terminal PostgreSQL
rows. Final FS channel count: zero. Final unacknowledged journal slots: zero.
Observed channel applications were only `unset`, `set`, `event`, `lua`, `respond`;
no `CHANNEL_ANSWER`, `CHANNEL_BRIDGE`, playback, originate or extra media path was observed.
During intentionally disconnected API ESL periods, the separate journal and actual SIP
dialogue supply the evidence; this does not claim an uninterrupted event subscription.
Fixture architecture excludes offers and media commands from the importer.

| Rejection fault              | Actual final SIP | Elapsed | RTP |
| ---------------------------- | ---------------- | ------- | --- |
| Four occupied journal slots  | 503              | 11 ms   | 0   |
| SQLite write lock held       | 503              | 110 ms  | 0   |
| Journal process SIGSTOP      | 503              | 1014 ms | 0   |
| Unavailable journal listener | 503              | 16 ms   | 0   |

Additional checks:

- `node --test --test-isolation=none tests/a03-ingress.test.mjs`: PASS, four U tests.
  These are local validation/transaction regressions, not FS/DB acceptance proof.
- `npm run quality`: PASS, OpenAPI, lint, formatting, typecheck, 262 API tests,
  134 web tests in 13 files, 53 operational tests and all workspace builds.
  Log: `/tmp/outbound-a03-quality.log`. Later FS terminal-metadata refinements were
  checked by the final runtime run and targeted ESLint/Prettier checks.
- `npm run test:prototype:ingress`: PASS, all nine original A02 FS scenarios,
  zero final channels; `/tmp/outbound-a02.UfExcBCu/`, log
  `/tmp/outbound-a03-a02-regression.log`.
- `bash -n scripts/test-a03-ingress.sh`, targeted ESLint/Prettier and
  `git diff --check`: PASS.

`TEST_DATABASE_URL` and `VOICEMAIL_TEST_PG_SOCKET` were unset; guarded product DB
suites were not exercised by quality. A03's separate real PostgreSQL fixture did run.
No integrated browser, product `test:freeswitch`, mixed load, restore, hosted CI,
provider or deployment check is claimed. Only local FS + DB proof is applicable
to A03; provider trust, delivered DID, retry/disconnect, audio/billing and forwarding
caller ID remain I04. Product implementation and target enablement remain later gates.
