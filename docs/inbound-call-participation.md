# B03 — Call origin, participation and concrete media statistics

Task: [B03 #11](https://github.com/sptmru/outbound-freeswitch-dialer/issues/11), under
[tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Date: 2026-11-14. Base: `af5b8ab` (schema 026); branch
`feat/b03-call-participants`. Local changes, uncommitted and undeployed.

## Schema and evidence semantics

Migration `027_call_participation.sql` is forward-only. It preserves the old call,
leg and media columns, legacy media keys, outbound default and migration checksums.
It does not enable ingress, transfers or the shared admission protocol.

`calls.direction` defaults to `outbound`. Inbound requires a fixed campaign,
`inbound_queue_id`, original DID, calling/called numbers, `arrived_at` and
`queue_deadline_at`. The queue/campaign foreign key prevents cross-campaign routing
references. Original number strings are snapshots, not dialable forwarding targets;
anonymous calling identities are allowed. Agent and contact remain nullable.
`destination_number` / `normalized_destination_number` remain required legacy
columns: inbound importers supply the delivered DID there and retain original
calling/called values separately. Inbound insertion must not mutate contacts or
outbound attempt counters. D03/D04 own that runtime integration.

Direction, origin numbers/DID, arrival, queue and campaign are immutable after
insertion. A transfer changes `calls.agent_id` as the current-owner projection,
without changing the product call or its campaign. Queue configuration changes
cannot move a referenced queue to another campaign. Historical configuration
snapshots and durable ingress/operation/offer entities remain B04 and later work.

The database admits `received`, `queued`, `connecting`, `agent_connected`,
`fallback`, `audio_playing` and `forwarding` in addition to the old state vocabulary.
Terminal states remain `completed`, `failed`, `canceled`. Existing terminal and
manual-status-lock guards are preserved. B05/later lifecycle tasks own the full
transition automaton and public contracts; accepting a string in SQL is not proof
that an application worker can process it.

Timestamps record separate evidence:

- `pstn_answered_at` is the carrier/customer answer boundary, including waiting audio.
- `agent_connected_at` is the first confirmed agent bridge, not a SIP agent answer.
- `queue_exited_at` and `fallback_started_at` distinguish queue exit and fallback.
- Each `call_participants` row records one concrete party interval: `joined_at`
  (participation/reservation begins), `connected_at` (confirmed conversation),
  `left_at` (confirmed departure), and optional `end_reason`.

Timestamp constraints allow missing evidence and delayed ingestion: an end may
arrive before a connection event is stored; a later update may fill an earlier
connection time. Known timestamps must remain chronologically consistent. No
queue-deadline reset or bridge confirmation is inferred from these nullable fields.
The internal `getCallParticipationHistory` model reports queue wait separately
from PSTN-to-agent delay and computes connected duration per participation. An
answered waiting call without an exit/bridge has unknown final queue wait.

`call_participants` supports agent, customer and external parties. Each leg may
reference one same-call, matching-role participant; each participant has at most
one concrete leg. A returning agent gets a new participant and leg, so A → B → A
retains three intervals and three media summaries. Identity cannot be reassigned.
The B02 slot participant foreign key also checks call and agent, preventing a
recipient slot from referencing another agent's participation. B02 fixtures now
create real participants instead of unrelated UUID placeholders.

## Media migration and writers

`call_leg_media_stats` retains the typed FS metrics, keyed by `call_leg_id`.
`persistCallMediaStats(..., { callLegId, ... })` requires matching call, role and
FS UUID; older event-time snapshots cannot replace newer data. Without
`callLegId`, existing workers continue to write the legacy projection. They are
not permitted to process new multi-leg lifecycles.

`call_participant_browser_media_stats` retains the typed browser metrics, keyed
by `participant_id`. The internal `upsertBrowserMediaTelemetry` accepts an
optional `participantId`: it authorizes the authenticated agent against that
participation and bounds the sample to its known joined/left interval. A former
owner can submit only their own interval; ownership of the current call grants
no access to someone else's segment. Older sample counts do not replace newer
summaries. This adds no HTTP request field or public endpoint: B05/G04 must expose
an appropriate versioned contract. The legacy call-only path refuses inbound and
native-participant calls and continues to support simple legacy outbound.

On upgrade, each evidenced legacy leg with a known owner (or customer role) gains
a `legacy_backfill` participant. Agent bridge times remain unknown: old
`answered_at` also advances on customer `CHANNEL_ANSWER` and cannot prove browser
connection. The old answer is copied only to `pstn_answered_at`.

FS summaries copy to concrete storage only on exact known leg UUID/type matches.
Browser summaries copy only when exactly one agent participation exists. No
ambiguous attribution is guessed. All unmatched/ambiguous original rows remain
in the legacy tables, without changes. Legacy intervals with contradictory raw
start/end evidence retain the raw leg timestamps; the new participant leaves the
unprovable departure unknown. Replaying the migration runner cannot duplicate data.

These copies are migration-time evidence snapshots. Feature-off legacy writes
continue in the original tables; there is no ongoing dual-write trigger or sum of
both representations. H03 must choose the appropriate source per lifecycle and
avoid counting the legacy projection and concrete evidence twice. C06/G04 own
production event correlation and participant interval updates. This foundation
alone does not make late hangups or actual media switching safe.

## Tested compatibility matrix

The previous source version is `af5b8ab` (immediately before B03, schema 026).
`dashboard/responders.ts` is unchanged in B03; the DB fixtures execute its actual
`getCallDetail` function before/after migration, compare the full result, and
preserve all pre-existing call/leg/media values and old migration checksums.

| Combination                                                                              | Support and evidence                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Previous reader + schema 027 + ordinary outbound                                         | Supported additive stage: fresh/026-upgrade DB fixtures preserve `getCallDetail`, old media keys and values; legacy-shaped media writes continue after upgrade.                                                                                                       |
| B03 internal reader + unassigned inbound/new states                                      | Tested with real PostgreSQL: nullable owner/contact, separate clocks and participant history. No public API contract claimed.                                                                                                                                         |
| B03 internal reader + transferred outbound/inbound                                       | Concrete schema is direction independent; repeated native inbound/outbound A → B → A fixtures preserves call campaign, distinct legs, per-participant duration and statistics.                                                                                        |
| Previous API/web/ESL/analytics/export/retention + any inbound or native transfer history | **Excluded, including after drain.** Legacy status mapping can treat unknown states as bridged; old workers join by leg role, telemetry authorizes by current owner and analytics attributes to final owner. Old media tables do not represent multiple participants. |
| New web + previous API for new actions                                                   | **Excluded.** No public offer/transfer/media contract is supplied by B03.                                                                                                                                                                                             |
| Rollback before new histories, feature off                                               | Previous source is a reader/writer compatibility candidate only; no image or rollback/deployment drill has run.                                                                                                                                                       |
| Rollback after new histories                                                             | No supported rollback binary is established. B05, C01–C07, G04, H01–H04 and I05 must establish the exact compatibility release and drill. Never reverse migration 027.                                                                                                |

Do not put inbound/transfer rows into a database served by excluded readers, even
when calls are terminal. This is an enablement restriction, not a runtime feature
flag or a claim that an old binary enforces the restriction. Old history/detail
responses, analytics, exports and retention are deliberately not broadened here.

## Acceptance and reproducibility

`call-participation.integration.test.ts` runs in both ordinary API discovery and
`npm run test:inbound:db`. The isolated runner hashes the new source/migration and
retains `b03-fresh-report.json`, `b03-upgrade-report.json`, `b03-native-inbound-report.json`, `b03-native-outbound-report.json`,
PostgreSQL version, revision, results and container cleanup evidence. No `.env`,
application database, network ports or provider endpoint is used.

| Criterion | Checks                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B03.1     | Fresh/upgrade from 026; unchanged old data/readers/checksums; nullable inbound; A → B → A; exact leg/participant media keys and FK isolation; cleanup.                                                                                                                                      |
| B03.2     | Pure timing tests plus real PostgreSQL delayed bridge/end fixtures, separate PSTN/queue/agent clocks, immutable origin/campaign and per-participant durations.                                                                                                                              |
| B03.3     | Actual unchanged previous `getCallDetail` over upgraded ordinary outbound, legacy-shaped writes and direct legacy reads of queued/terminal native fixtures showing their missing direction/participant/media contracts; the exclusions above apply and new history uses the internal model. |

Local commands/results and retained artifacts are recorded below after execution.
No browser, FS, RTP, provider, target deployment or rollback-drill proof is supplied
by these schema/API checks. Those remain the later runtime acceptance tasks.

### Local verification result — 2026-11-14

All B03.1–B03.3 criteria passed at their specified U/DB/API levels. Node.js
`v23.7.0`; no hosted CI execution was requested or performed.

- `npm run test:inbound:db:isolated`: **11/11 passed, zero skipped** on pinned
  PostgreSQL 17. Final artifacts: `/tmp/outbound-inbound-db.lra65MMc/`.
  Includes fresh/026-upgrade, unmatched/ambiguous legacy evidence retention,
  native inbound/outbound A → B → A with the recipient's Desk on another
  campaign, concrete statistics, rejected telemetry and cleanup.
- `bash /tmp/b03-quality-pg16.sh`: **passed**. This local wrapper uses the same
  network-none/socket-only disposable runner as `scripts/test-inbound-db.sh`,
  pins the existing PostgreSQL 16 image and substitutes `npm run quality` for
  the focused command. Its exact source is retained as
  `/tmp/outbound-inbound-db.d1iZNNBj/runner.sh`; results, image/source hashes and
  DB evidence are in that directory. OpenAPI, lint, formatting, typecheck,
  **293 API + 135 web + 76 ops tests**, and all builds passed. The separate
  voicemail suite was skipped by this environment and then run below. The
  final test-only Desk-campaign fixture addition was verified by the final
  PostgreSQL 17 DB run and focused lint/format checks.
- `npm run test:voicemail:db`: **8/8 passed, zero skipped**, on its separate
  disposable PostgreSQL 16 socket fixture. Output: `/tmp/b03-voicemail-result.txt`.
- `git diff --check`, focused ESLint/Prettier and a whitespace/EOF check of all
  five new files: **passed**. Test containers and isolated schemas were removed;
  both inbound runner cleanup records are retained.

PostgreSQL image digests: 16
`sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`;
17 `sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`.

The full gate found an inherited migration-012 issue: its `pg_constraint` name
lookup is not schema scoped. After the public schema is initialized, a later
isolated schema can lack `calls_state_valid`. Migration 027 now drops that
constraint with `IF EXISTS` and establishes its own check; applied migration 012
is unchanged. The full gate passed after this correction.

No B/FS/L/P checks, real browser media, deployment, provider calls, rollback drill,
commit, push or PR were performed. B03 requires U/DB/API evidence; product runtime
integration and I01–I05 gates remain separate. The old-reader exclusions above
remain mandatory before any new live **or retained historical** data is introduced.
