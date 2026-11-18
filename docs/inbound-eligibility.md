# C07 — Eligibility and supervisor coordination

Task: [C07 #20](https://github.com/sptmru/outbound-freeswitch-dialer/issues/20).
Completion branch: `feat/c07-supervisor-completion`, based on merged `dev` `59f3565`.
The earlier eligibility slice is retained. This change completes the C07 protocol
and its local DB/FS checks; production bootstrap/enablement remains I05.

## Eligibility mutations

`apps/api/src/eligibility.ts` supplies short `READ COMMITTED` transactions:
admission `(72202,0)` → campaign parents when needed → sorted user media/user
parents → sorted agents → sorted slots → Desk/transfer/offer/intent writes.
Lock/statement/idle limits are 250/500/1000 ms. No ESL, network or filesystem work
belongs in the callback, and no caller may wrap admission in a session media lock.

Pause, campaign change and clearing readiness invalidate only pending recipient
offers/transfers and pending/deferred automatic intents. Accepted offers, started
intents, connecting transfers and occupied slots survive. An elapsed offer is
`expired` / `deadline_elapsed`, preserving its permanent exclusion; an ordinary
eligibility cancellation does not manufacture an Ignore. Resume never revives
canceled work. Authentication and controller/revision/binding/lease checks use
fresh database state after locking. Legacy `wrap_up` reads project `available`;
reads do not issue a corrective UPDATE.

`changeDeskEligibility` is D01's internal adapter. It clears readiness and changes
campaign selection; it cannot verify SIP registration, publish positive readiness,
take over a controller or release media. Registration events/reconciliation use
the common gate, but the legacy shared-username `registered` flag remains telemetry.
D01 owns per-controller identity, exact binding verification and freshness.

## Native supervisor producer and executor

Migration `032_supervisor_coordination.sql` adds an explicit `legacy`/`native`
protocol discriminator, session generation/root operation, and immutable
`supervisor_leg_evidence`. An upgrade preserves existing sessions as legacy.
Each native generation retains its UUID, originate operation and exact answer/
terminal evidence after replacement; late old events cannot project current state.
`CHANNEL_HANGUP` alone is insufficient: cleanup requires COMPLETE or DESTROY.

The existing authenticated admin POST/PATCH/DELETE routes accept native operations
through the optional seventh `registerDashboardRoutes` dependency. Native requests
require a UUID `Idempotency-Key`; the web client supplies it. Replays retain the
original operation. A distinct key for an already active start/same mode or an
ended stop is refused instead of creating an unrecorded successful alias. No browser-supplied
route/UUID becomes authority. The server resolves one `sofia_contact` route outside
admission, validates active admin/auth version and endpoint identity inside it,
and rechecks the exact route plus both target UUIDs immediately before send.
The target must have one live current-owner agent leg and one customer leg, in
`bridged`, `agent_connected` or `voicemail_signal_detected`.
[G04](inbound-post-transfer-boundaries.md) blocks starts/mode changes while a transfer
is open, ends existing supervision before switching, and permits a new explicit
listen-first session against the current owner after completion.

Admission discovers the supervisor actor's Agent Desk slot, including before any
SIP leg exists. Either occupied Desk or connecting/active supervisor excludes the
other workflow. A new supervisor session claims one C02 `supervisor_channel`
permit, also counted against total channels, in the intent transaction. Failed
capacity admission rolls back session, leg journal and operations together.

C03 executes one fixed Job-UUID and leg UUID per physical command on its bounded,
separate non-superuser connection pool. Short SQL validation completes before ESL;
only the rank-0 per-call execution lock spans that bounded command. No user-media
session lock spans native network work. A mode change enqueues old-leg hangup and
a dependent replacement originate. The replacement waits for successful fixed
hangup-job completion AND exact old-leg cleanup; the same session permit spans
nonoverlapping generations. Failed predecessors cancel never-sent children.

An ACK, absent-channel probe, deadline or retry does not clear uncertainty. The
endpoint and permit remain occupied until fixed-job and exact channel evidence
resolve the operation. A negative completed job plus exact absence can resolve a
failed originate; positive originate completion also needs exact answer evidence.
Reconciliation wakes the same durable identity and never sends it twice. Missing
evidence stays conservative; H01 owns the eventual recovery worker. Stop releases
only supervisor occupancy/capacity, preserving the target conversation. C02 can
retain a permit while another operation on the same call remains unresolved.

Production `server.ts` does not yet inject the staged native adapters, consistent
with C04/C06. Reconciled native mode without the adapter fails closed with 409;
legacy start/mode/stop also refuse that marker before ESL. Legacy SQL event/failure
writers are fenced to `coordination_protocol='legacy'`. I05 must drain legacy work
and wire the adapters before enablement; the marker is not a supported live toggle.
The feature-off legacy mode/stop sender remains isolated from the native protocol.

## Completed A01 writer inventory for C07

The original A01 tables are a historical baseline. This table records the current
edges and exclusions needed before inbound starts can be enabled.

| Writer / source                                                                                                                                                   | Ordered protocol and boundary                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native manual/lead/next, auto-next, supervisor; `manual-outbound.ts`, `auto-next.ts`, `supervisor-coordination.ts`                                                | Maintenance row before admission for new starts; gate, parent discovery/revalidation, media/user, agent/slot, lifecycle, capacity/contact. C03 validation repeats authority; ESL follows SQL COMMIT.                                                                                                                                 |
| Pause/resume and Desk selection/readiness; `agent-availability.ts`, `eligibility.ts`                                                                              | Gate before media/agent/slot and child invalidation. No occupied release, no read-side wrap-up UPDATE. D01 positive binding publication must use this boundary.                                                                                                                                                                      |
| User update/deactivation/delete; `auth/routes.ts`                                                                                                                 | Gate before user-media/user then agents and controller/pending-work changes. Active supervisor and occupied owner/recipient/pre-SIP slots prevent incompatible removal. Feature-off unreconciled empty slots do not block legacy administration. Credentials/files/registration refresh follow COMMIT.                               |
| Registration event/reconciler; `agent-registrations.ts`                                                                                                           | Sofia query outside transaction; gate before sorted user/agent/slot writes. Legacy registration flag cannot mark a native Desk binding ready or release occupancy. Endpoint allocation is additive and does not move an admitted native binding.                                                                                     |
| Campaign PATCH/archive/reset; `dashboard/routes.ts`, `dashboard/campaigns.ts`                                                                                     | Gate before campaign and selected agent/slot locks. Pause/archive invalidates pending work; disabling automatic advance cancels that campaign's pending intents. Archive/reset check active calls under the gate. Parsing/import batches remain outside admission.                                                                   |
| Campaign audio upload/assign/delete; `dashboard/recordings.ts`                                                                                                    | Gate before campaign audio advisory/row locks. File decoding is outside SQL; removal follows COMMIT. Native VM selection pins audio inside the ordered admission transaction.                                                                                                                                                        |
| Native end/VM, events and cleanup; `native-call-control.ts`, `call-cleanup.ts`                                                                                    | C03 command intent and exact concrete leg evidence; ordered admission for releases, capacity then contact cleanup; unresolved sender retains occupancy. Supervisor has its own generation journal, never role-wide call-leg updates.                                                                                                 |
| Legacy manual/lead/next, VM claim, hangup/release/finalization and manual status; `dashboard/calls.ts`, `call-finalization.ts`, `dashboard/manual-call-status.ts` | Gate precedes agent/call locks; maintenance-sensitive starts read maintenance first. Native histories/starts are refused by legacy send/repair paths. C06 concrete release handles native rows. Terminal manual correction does not reopen occupancy.                                                                                |
| Legacy supervisor start/mode/stop and events; `dashboard/supervisor.ts`                                                                                           | Start reads maintenance before gate/media. All legacy send entry points reject reconciled native mode. Old session-media mode/stop cannot acquire native admission below their session lock; native executor has no such wrapper. Legacy projections cannot write native sessions.                                                   |
| Certificate maintenance; `scripts/certificate-runtime.sh`                                                                                                         | Host operation lock then maintenance flag UPDATE, committing before network/reload/drain polling. API takes row SHARE before admission; maintenance never waits for admission while holding it. I05 still owns full durable drain/rollback checks.                                                                                   |
| Migrations, retention, imports, suppression, recording/PCAP metadata                                                                                              | Their schema/retention/phone locks do not enter admission below an existing lock. They cannot allocate/free native slots or capacity. Native operation/capacity/offer FKs restrict history deletion; H04 owns retention/media cleanup policy. Callable/suppression is freshly rechecked by C04; file/bulk work is outside admission. |

No enabled legacy path can authorize an uncounted native media send. Later D–H
producers must use these boundaries before I05 wires them; this review does not
claim their still-unimplemented workflows or A01's entire future S1–S7 matrix pass.

## Verification and acceptance mapping

| Criterion | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C07.1     | `eligibility.integration.test.ts`: separate Node/PostgreSQL backends, pre-COMMIT barriers, observed `pg_blocking_pids`, both orders and either rollback for pause/campaign/readiness. Checks canceled intent/offer, occupied reservations, deadline exclusions and fresh revisions.                                                                                                                                                                                                                                                   |
| C07.2     | `supervisor-coordination.integration.test.ts`: four cross-process supervisor/Desk schedules, concurrent capacity competition, real HTTP/C03 framing, idempotent replacement/stop, stale endpoint/negative job refusal, uncertainty/reconciliation without resend and immutable upgrade/evidence. `test:supervisor:freeswitch`: actual SIP/RTP listen/whisper/join, duplicate concurrent start, capacity rejection, Desk exclusion, old COMPLETE before new CREATE, late old events, one retained permit and target-call preservation. |
| C07.3     | Inventory above; eight observed blocking schedules for maintenance/supervisor and audio/concrete release, both orders and either rollback. Full quality includes feature-off manual/lead/next/VM/supervisor regressions; separate campaign-audio PostgreSQL suite and existing C03/C06 FS regressions validate the shared sender/release boundary.                                                                                                                                                                                    |

Reproduction commands and final run results are recorded below and in issue #20.
All containers are disposable, pinned, without host-published ports or external
network access. DB-only admission fixtures do not establish media. The FS lab uses
UDP SIP and decoded PCMU RTP; browser/WebRTC, provider, hosted CI, load/soak,
production enablement and rollback/drain acceptance are separate, unverified gates.

## Final local results — 2026-11-15

- `INBOUND_PG_STORAGE=tmpfs bash /tmp/c07-quality-pg16.sh`: passed full
  `npm run quality`, 365 API tests with zero skips, 135 web tests, 76 ops tests,
  OpenAPI/lint/format/types and all builds. Artifacts:
  `/tmp/outbound-inbound-db.rHJGFqvz/result.txt`.
- `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`: passed 71/71 PG17
  tests, zero skips. Artifacts: `/tmp/outbound-inbound-db.jlPD1ibn/result.txt`,
  `c07-eligibility-report.json`, `c07-supervisor-*.json`, `c07-mixed-locks.json`
  and `c07-migration.json` in that directory.
- `npm run test:supervisor:freeswitch`: passed seven groups, including the
  controlled concurrent Desk reservation before supervisor's first physical send,
  actual listen/whisper/join audio and zero remaining channels. Final artifacts:
  `/tmp/outbound-c07.SqF6B0Ec/report.json`, source/image hashes, isolation metadata.
- `npm run test:executor:freeswitch`: passed five existing C03 fault/budget groups;
  `/tmp/outbound-c03.sLOm6Nsk/report.json`, `/tmp/c07-c03-regression.log`.
- `npm run test:cleanup:freeswitch`: passed seven existing C06 cleanup/VM/native
  HTTP groups; `/tmp/outbound-c06.5BK1U07Y/report.json`,
  `/tmp/c07-c06-regression.log`.
- `npm run test:voicemail:db`: passed 8/8, zero skips;
  `/tmp/c07-voicemail-completion.log`.
- Focused final C07/auth checks, shell syntax, 123 local document links and
  `git diff --check` also passed. Test containers were removed.

The PG16 wrapper derives from `scripts/test-inbound-db.sh`, pins this checkout as
its root, substitutes cached PG16 image
`postgres@sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`
and runs `npm run quality` with a 300-second outer bound. PG17 and FS images are
pinned in the repository runners. No `.env` or application database was used.

The first additive migration run exposed C06's assumption that no migration
followed 031; its history comparison now explicitly selects pre-031 rows. Later
parallel volume-backed runs hit timing failures/interrupted total bounds and are
not passing evidence (`hM30S60s` / `XeVBEz1u`). Final acceptance runs above were
sequential on the already-supported disposable tmpfs option; product lock,
statement, execution and capacity limits were unchanged. These are local temporary
artifacts, without hosted publication or target-storage/load acceptance.
