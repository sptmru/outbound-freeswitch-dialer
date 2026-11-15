# C06 — Fenced call cleanup and background voicemail

Task: [C06 #19](https://github.com/sptmru/outbound-freeswitch-dialer/issues/19).
Base: `f4c3564` (`dev`); local branch `feat/c06-fenced-call-cleanup`.
Status: local cleanup implementation verified; native control integration remains
open. This change does not enable inbound, transfers or native outbound execution.

## Concrete evidence and ownership

`apps/api/src/call-cleanup.ts` routes native lifecycle events through C01 common
admission. A native history is an inbound call, a call with a native participation,
or a call with durable operations. An event must match its immutable
`(call_id, freeswitch_uuid, participant_id)` relation. The event's role label cannot
select a different leg. Unknown UUIDs neither create legs nor mutate the call.

Migration `031_participant_slot_cleanup.sql` captures the full reservation UUID and
bigint generation on each native agent participation. An occupied reservation
cannot replace its participation; its snapshot cannot change or be reused by a
returning participation. Upgrade snapshots only existing native occupied slots.
Nullable columns preserve legacy writers; migration/cutover markers stay unchanged.

`CHANNEL_HANGUP` can establish customer termination, but only an exact
`CHANNEL_HANGUP_COMPLETE` or `CHANNEL_DESTROY` marks that leg cleaned. An agent
participation ending never terminates the customer call. Late setup events cannot
reopen an ended participation/leg or overwrite a terminal call/manual correction.
Customer hangup outcomes share the existing pure resolver in `call-outcomes.ts`.
PSTN answer remains separate from an established agent conversation.

Cleanup checks all unresolved operations, including past-deadline commands. They
retain uncertain slots and capacity even after a missing-channel observation or
terminal event. `reconcileCoordinatedCallCleanup` can settle persisted concrete
cleanup after C03 independently establishes sender quiescence and definitive job
resolution. It issues no command, resolves no operation and manufactures no
absence evidence. A resolved originate job alone does not end its resulting leg.

Release matches the participation's full token. Browser capacity matches the
specific leg or agent/generation; customer/trunk capacity remains while customer
work continues. Unknown concrete/supervisor/overlap claims are retained rather
than guessed free. Queue and external claims require terminal customer cleanup.
G02/H01 still own their action-specific switch/recovery release decisions.

The C01 resource discovery includes ended participants so their late cleanup
locks former owners in sorted order. Slot release, capacity and outbound contact
cleanup occur under the same gate, with contact writes last. `finishAgentCall`
cannot mark an agent ready across a real occupied native slot and preserves pause.
Unreconciled feature-off initialization snapshots remain distinct from real claims.

## Voicemail and legacy paths

Confirmed matching agent-leg cleanup during voicemail makes the call
`agent_released`, persists the release event/time, frees only its reservation and
browser capacity, and permits a new interactive admission. Customer/trunk resources
remain. Later playback completion/customer hangup cannot clear a newer slot, alter
its operation/contact/capacity, or clear pause. Completion events do not synthesize
other legs' cleanup. Terminal state and immutable manual correction remain stable
across either completion/hangup delivery order.

The repo-owned `voicemail-drop.xml.tpl` now explicitly emits `Event-Name=CUSTOM`.
Without it, the pinned FreeSWITCH `event` application creates
`CHANNEL_APPLICATION`, so a CUSTOM subscription misses the playback events.
The isolated debug trace showed the application executing without a subscribed
playback event; the corrected template produced the real start/completion events
and decoded WAV playback. See the
[FreeSWITCH 1.10.12 implementation](https://github.com/signalwire/freeswitch/blob/v1.10.12/src/mod/applications/mod_dptools/mod_dptools.c#L1764).
No generated or deployed configuration was edited.

Legacy owner/finalization transactions now acquire admission before agent/call
rows. The HTTP voicemail release writes its event, guarded call/UUID update and
agent projection atomically. Legacy feature-off command behavior is preserved;
its ACK-based release must not be reused for native calls. Legacy watchdog,
consistency repair, reconnect probing, end-call and voicemail execution cannot
optimistically finalize/release or directly send commands for native histories.

## Remaining integration boundary

`server.ts` still supplies no native C03 execution adapter, as in C04/C05.
This task adds no bootstrap activation, provider configuration or new credentials.
Native end-call returns the existing unavailable/not-found result; native voicemail
drop refuses with 409 after owner lookup. It cannot fall through to legacy
`uuid_transfer`/`uuid_kill`. The lab uses test-only admission, explicit command
adapters and event delivery to exercise the product cleanup implementation.

The remaining C06 integration is a native hangup/voicemail producer and executor
adapter: persist action identities under admission, send through C03 after commit,
resolve ambiguity without releasing resources, and call cleanup after definitive
resolution. It must be tested through the actual API control path before claiming
the entire C06 workflow complete. C06 therefore remains open in GitHub and the
tracker is not checked. This is separate from G02's explicitly assigned transferred
FS regression and from the later bootstrap/enablement gates.

Native recording, detection, connection/transfer media decisions and scheduling
must use their owning C03/D/E/G/H adapters; this cleanup handler does not issue
legacy recording/detection commands on native setup events. H01 owns restart
scheduling and sender reconciliation. Feature-off regression success does not
establish native product activation or target acceptance.

## Verification

`apps/api/src/call-cleanup.integration.test.ts` runs in ordinary API tests and
`test:inbound:db`. The suite uses real PostgreSQL and controlled commit/rollback.
`tests/fixtures/inbound/cleanup-worker.mjs` runs actual cleanup/manual-admission
entry points in separate OS processes/backends. IPC holds COMMIT; mandatory
`pg_blocking_pids` assertions establish the competing gate order. Tests cover
cleanup-first commit and rollback, admission-first occupied refusal, post-lock
eligibility, operation resolution versus cleanup, replay, terminal correction,
ownership changes and migration 030→031/participation ABA. They inspect calls,
slots, participants, legs, operations, capacity, contacts, offers and transfers.
SQL fixture media/cleanup facts are simulated, never provider proof.

`npm run test:cleanup:freeswitch` creates private pinned FS/PostgreSQL containers
with `--network none`, shared private network namespace, no published ports and
disposable Unix socket/database. It never reads `.env` or `DATABASE_URL`.

- C06.1: actual C03 sender, TCP relay holding command bytes, missing UUID, delayed
  originate, lost response, exact job, closed sender/relay, no duplicate send,
  retained uncertainty and later concrete terminal cleanup.
- C06.2: actual SIP answer/bridge, decoded bidirectional 440/880 Hz PCMU,
  repo-owned voicemail dialplan playing a 660 Hz WAV, live customer after agent
  release, new media legs/slot and pause, both old completion/hangup orders,
  duplicate replay and final zero FS channels.
- C06.3: DB replay/manual-correction matrix. The actual transferred-call FS matrix
  remains assigned to G02 by the issue; the C06 lab does not claim it passed.

Artifacts retain source hashes/base revision, versions, command/event ledgers,
SQL snapshots, decoded tone measurements, process identities and container/schema
cleanup. Local artifacts are temporary files, not hosted CI uploads. Final command
results and paths are recorded below after verification.

Unrun gates: native API hangup/voicemail integration, browser/WebRTC, provider,
mixed load/soak, target storage, hosted CI, deployment/drain/rollback and production.
No commit, push, PR, deployment, provider call or production mutation occurred.

## Verified local result — 2026-11-15

Node.js 23.7.0 (required >=22). All final runners exited 0.

| Command / environment                                                                                                 | Result / artifacts                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INBOUND_PG_STORAGE=tmpfs bash /tmp/c06-quality-pg16.sh`                                                              | PASS: full `npm run quality`, PostgreSQL 16.16; OpenAPI, lint, formatting, types, 350 API tests with zero skips, 135 web tests, 76 ops tests and all builds. `/tmp/outbound-inbound-db.D1YwYdSe/`.                           |
| `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`                                                           | PASS: PostgreSQL 17.11, 56/56 DB tests, zero skips, including all seven C06 tests. `/tmp/outbound-inbound-db.d0HJDz1M/`.                                                                                                     |
| `npm run test:cleanup:freeswitch`                                                                                     | PASS: pinned FreeSWITCH 1.10.12 and PostgreSQL 17.11; all three integrated C06.1/C06.2 scenario groups. `/tmp/outbound-c06.2iFcNNyy/`, including report, real events, decoded tone measurements, command ledger and cleanup. |
| `npm run test:voicemail:db`                                                                                           | PASS: 8/8 legacy campaign voicemail DB/API regressions, zero skips; simulated ESL, not actual playback/provider proof. `/tmp/c06-voicemail-db-result.txt`.                                                                   |
| `npx eslint . --max-warnings 0`; `bash -n scripts/test-c06-cleanup.sh scripts/test-inbound-db.sh`; `git diff --check` | PASS.                                                                                                                                                                                                                        |

The PG16 wrapper derives from `scripts/test-inbound-db.sh`, changes root
resolution, substitutes cached image digest
`sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`
and invokes `timeout 300 npm run quality`. The PG16/17 DB runners use disposable
tmpfs; this is concurrency/transaction proof, not target disk-crash durability or
storage performance. FS uses its declared private lab storage. Containers, schemas,
executor roles and workers were removed/reaped; cleanup files retain evidence.

Initial development failures were corrected: fixture contact uniqueness and active
owner constraints; a lab endpoint outside the A04 finite fixture address set; and
the confirmed missing `Event-Name=CUSTOM` in the real dialplan. One intermediate
quality run overlapped an edit of the new, unapplied migration 031 and correctly
failed its checksum guard. It is not counted as a passing run. The final full
quality/DB/FS results above use the stable final source; no applied product
migration or checksum guard was changed or bypassed.
