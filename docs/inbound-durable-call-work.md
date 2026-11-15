# B04 — Durable offers, transfers, operations, auto intents and ingress evidence

Date: 2026-11-14. [B04 / #12](https://github.com/sptmru/outbound-freeswitch-dialer/issues/12),
under [tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Branch: `feat/b04-durable-call-work`. Base: `d6a22846f27078a22b81eb2c0f631bf2ce24bd9d`.
Changes are local and uncommitted. Product inbound and transfers remain disabled.

## Selection and scope

Fetched all current GitHub issues, the full tracker, B04, its comments and timeline,
and the open PR collection. A01–A07 and B01–B03 are closed. B04's dependency
statement and links require A03, A07 and B01–B03, all satisfied. A02's provider
deferral and A07's local acceptance amendment permit this isolated schema work.
B04 was the first open task by ID, unassigned and without a start comment or open
PR; repeated those checks before claiming it. The checkout was clean. No task was
selected merely from issue numbers or tracker checkboxes.

Read AGENTS.md, searched the Developer Knowledge Base for the task, exact
`call_operations` identifier and related ingress incidents, and reviewed
[requirements](requirements.md), [architecture](architecture.md),
[implementation status](implementation-plan.md), [ADR 0001](adr/0001-initial-architecture.md),
[the source plan sections 4–6 and 8](inbound-calling-implementation-plan.md),
the A03 journal protocol and B01–B03 migrations/contracts.

Migration `028_durable_call_work.sql` is additive. It seeds no product work,
rewrites no legacy rows and changes no HTTP/shared contract. Existing migration
checksums remain unchanged. Legacy outbound remains writable. B02 capacity
`operation_id` values, including legacy backfill UUIDs, deliberately do not gain a
mandatory FK here: older writers do not create `call_operations`. C02/C03 must
associate new admissions with durable operations before enablement.

## Storage contract

| Table                      | Durable identity and lifecycle                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call_offers`              | Call/kind/agent/attempt, Desk session/revision/binding generation snapshots, fixed deadline, state and closure reason. A partial unique index permits one `pending` offer per agent across inbound and transfer kinds. Closing an offer does not change a call, slot or transfer. |
| `call_offer_exclusions`    | Primary key `(call_id, agent_id)`, original source offer/reason/time. Ignored or expired inbound closure inserts the exclusion in the same transaction, including direct closed inserts. No session/campaign key can reset it.                                                    |
| `call_transfers`           | Call/attempt, source participation and recipient; separate offered/connecting/switching/uncertain/terminal lifecycle. One unfinished transfer per call, including uncertainty; an assigned operation belongs to that call and cannot be replaced.                                 |
| `call_operations`          | Globally unique scope/key, immutable SHA-256 request fingerprint, command kind, generation, fixed command/target UUIDs and bounded request. Pending/executing/uncertain differ from succeeded/failed/canceled. Terminal result/evidence is immutable.                             |
| `agent_auto_next_intents`  | Unique agent/source completion plus stable unique retry UUID; campaign/Desk revision snapshot. Pending/deferred owns no new call; started binds one call and its operation; canceled and started cannot regress.                                                                  |
| `inbound_ingress_evidence` | Internal FS ingress UUID is the primary key. Journal identity, original arrival, validated DID, route revision and queue deadline survive import/replay. Nullable unique `call_id` allows pre-call and terminal-only evidence.                                                    |

Offers close as `accepted`, `ignored`, `expired`, `declined`, `canceled` or `failed`;
acceptance is an offer decision, not proof of bridge or terminal customer outcome.
Expiry uses `deadline_elapsed`. Explicit Ignore uses `user_ignored`; successful
manual outbound uses `manual_outbound_started`. `winner_accepted` is cancellation,
never an ignore/expiry exclusion. Transfer offers do not create inbound exclusions.
Closed offers/transfers and their original identities/deadlines cannot be edited
or reopened. Exclusion reason/time/source cannot be rewritten.

Future dispatch and auto-priority readers must use the same predicate:

```sql
not exists (
  select 1 from call_offer_exclusions e
  where e.call_id = candidate.id and e.agent_id = $agent_id
)
```

An offer candidate written by a stale dispatcher does not erase this exclusion.
This migration does not implement dispatch filtering, deadline decisions,
eligibility validation, atomic transfer decline or a winner/slot admission gate.
C/E/G must apply that predicate and revalidate current state under common admission.
Desk/binding revisions are historical snapshots, not proof of a currently verified
SIP endpoint. C05 must validate qualifying outbound source completion and cancel
stale intents under admission; this schema alone cannot authorize automatic dialing.

## Import, uncertainty and retention

The three per-ingress checkpoints satisfy:
`0 <= acknowledged_sequence <= imported_sequence <= evidence_sequence`.
All are monotonic. New terminal evidence requires an advanced evidence sequence;
the original arrival/deadline and recorded terminal evidence cannot be reset by a
late live snapshot. Terminal evidence can only link to terminal product history.
An existing terminal call cannot be made live through replay or by clearing its
end timestamp while linked to terminal evidence.

D03 must commit product history and `imported_sequence` together, then acknowledge
the external journal **after commit**, and only then record `acknowledged_sequence`.
These are per-ingress checkpoints, not a global journal cursor. SQL bounds cannot
prove that a journal acknowledged a commit or that the source is trusted; D03
must supply authentication, authoritative discovery, retry and transport handling.
The tests simulate a lost external ACK after an actual PostgreSQL COMMIT; no
product importer, journal transport, FreeSWITCH or provider traffic runs here.

Unknown commands remain `uncertain`. They cannot return to pending/executing,
change UUID/fingerprint or be deleted. Resolution requires a nonempty evidence
reference and a terminal timestamp; success also requires a result. The database
cannot establish whether that reference proves media cleanup. C03/H01 must do so
under the chosen executor protocol; timeout or command acknowledgement is not proof.

Deletion is deliberately conservative:

- Unresolved operations, live-call operation retry keys and operations with
  unreleased capacity cannot be deleted. Calls cannot cascade-delete operations.
- Open offers/transfers and their live-call history cannot be deleted. Live-call
  exclusions cannot be deleted, and their source offers are FK-protected.
- Pending/deferred auto intents must be explicitly canceled rather than deleted.
- Live ingress evidence and terminal evidence not fully acknowledged cannot be
  deleted. An acknowledged live import still owes terminal evidence.

No retention job is added. H04 must define the deduplication horizon and prune
resolved dependencies in order, including exclusions before their closed offers,
and acknowledged terminal ingress before its call. Eligibility for deletion is
not permission to discard a key while journal/client retries remain possible.
Existing retention can fail conservatively on these new references once native
work exists; integrate H04 before enablement. Rollback to a legacy binary needs
the existing feature-off/drain and reader exclusions, not schema reversal.

## Acceptance checks

`npm run test:inbound:db` now includes
`apps/api/src/durable-call-work.integration.test.ts`; the isolated runner hashes
that file and migration and retains `b04-*.json` snapshots. No populated `.env`,
application database, host port or provider endpoint is used.

| Criterion | Verification                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B04.1     | Fresh and 027-upgrade; unchanged legacy call, checksum-aware migration replay, direct unique/ownership conflicts and retained closed history. Sixteen real blocking schedules cover offers, transfers, operation retry keys and ingress UUIDs, each in both commit orders and with rollback. The tests observe `pg_blocking_pids` before choosing the outcome. Fixed command UUID uniqueness and immutable fingerprints/generations prevent reassignment. |
| B04.2     | Transactional ignore/expiry plus rollback; explicit/manual Ignore and expiry retain different reasons. Recreated attempts under replaced Desk sessions and another selected campaign still encounter the original exclusion predicate. Winner cancellation permits another eligible attempt and cannot create an exclusion. Live deletion/history mutation is rejected.                                                                                   |
| B04.3     | Independent pre-call terminal evidence; actual history/checkpoint COMMIT followed by lost-ACK replay on another connection; unchanged identity/age and one history row; stale live evidence and terminal-call resurrection rejected. Monotonic checkpoints, acknowledged-live retention, later unacknowledged terminal retention, uncertain operations/fixed UUIDs, completed retry keys, source-intent deduplication and terminal guards.                |

## Local verification result — 2026-11-14

B04.1–B04.3 passed at their required DB level. Node.js `v23.7.0` (required >=22).

| Command / environment                                                                | Result and retained local evidence                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash /tmp/b04-quality-pg16.sh`                                                      | PASS, PostgreSQL 16.16. Runs `npm run quality` with an explicit isolated `TEST_DATABASE_URL`: OpenAPI, lint, formatting, types, 298 API tests, 135 web tests, 76 ops tests and all builds. `/tmp/outbound-inbound-db.h9uDIBjf/` contains the exact wrapper, pinned image/source hashes, `result.txt`, B04 snapshots and cleanup record. The separate voicemail suite was skipped here and executed below. |
| `bash scripts/test-inbound-db.sh` (`npm run test:inbound:db:isolated`)               | PASS, pinned PostgreSQL 17.11: 16/16 tests, zero skipped. Includes A07/B01–B04 and fresh/upgrade/race/replay checks. Final-code evidence: `/tmp/outbound-inbound-db.Y8kYXZoj/`; source hashes verified against the final migration/test files.                                                                                                                                                            |
| `npm run test:voicemail:db`                                                          | PASS: 8/8 existing voicemail PostgreSQL tests, zero skipped, separate disposable PostgreSQL 16 fixture. `/tmp/b04-voicemail-result.txt`.                                                                                                                                                                                                                                                                  |
| `git diff --check`, focused Prettier/ESLint and `bash -n scripts/test-inbound-db.sh` | PASS.                                                                                                                                                                                                                                                                                                                                                                                                     |

Both inbound containers and their schemas were removed; cleanup records are
retained. The voicemail runner also removed its disposable fixture. Earlier PG17
evidence at `/tmp/outbound-inbound-db.a5JE5q5K/` precedes final retention/test
refinements; the final result above supersedes it.

These are real database checks with synthetic call, journal and command metadata.
No browser, FreeSWITCH/RTP, provider, target deployment/load, hosted CI, product
enablement or production validation was performed. Those later gates are outside
B04's schema acceptance. No commit, push, PR or deployment was performed.
