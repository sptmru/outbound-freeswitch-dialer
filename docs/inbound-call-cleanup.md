# C06 — Fenced call cleanup and background voicemail

Task: [C06 #19](https://github.com/sptmru/outbound-freeswitch-dialer/issues/19).
The cleanup core was merged into `dev` as `02eca66`. Its native control follow-up
is local and uncommitted on `feat/c06-native-call-controls`.
Global native bootstrap/enablement remains staged under I05.

## Concrete evidence and ownership

`apps/api/src/call-cleanup.ts` handles native lifecycle events under C01 common
admission. A native history is an inbound call, a call with a native participation,
or a call with durable operations. Events must match the immutable
`(call_id, freeswitch_uuid, participant_id)` relation. Unknown UUIDs cannot invent
legs, change ownership or release resources.

Migration `031_participant_slot_cleanup.sql` captures the full reservation UUID
and bigint generation on each native agent participation. An occupied reservation
cannot replace its participation; its snapshot cannot change or be reused by a
returning participation. This follow-up adds no migration and changes no applied
migration or cutover marker.

`CHANNEL_HANGUP` can establish customer termination. Only matching
`CHANNEL_HANGUP_COMPLETE` or `CHANNEL_DESTROY` marks that leg cleaned. An agent
participation ending never terminates the customer call. Late setup events cannot
reopen ended participation/legs or overwrite terminal state/manual correction.
Customer and agent-end outcomes share `call-outcomes.ts`; PSTN answer is separate
from an established agent conversation. An attempted matching native hangup keeps
the existing `answered` versus `agent_canceled` policy, while terminal state still
requires a concrete customer event. The ESL retry queue treats
`AdmissionDiscoveryChanged` as retryable, reacquiring the complete lock graph
without dropping the concrete event.

Cleanup checks every unresolved operation, including expired commands. They
retain uncertain slots/capacity even after a missing UUID or terminal event.
`reconcileCoordinatedCallCleanup` settles persisted concrete cleanup only after
C03 independently resolves command uncertainty. A resolved originate job does
not end its resulting leg. TTL, ACK, missing UUID and playback completion do not
synthesize another leg's cleanup.

Release matches the participation's full token. Browser capacity matches the leg
or agent/generation; customer/trunk capacity remains during background work.
Unknown supervisor/overlap claims are retained. Discovery includes ended
participants so late cleanup locks former owners. Slot release, capacity and
outbound contact cleanup use the same gate, with contacts last.
`finishAgentCall` preserves pause and cannot mark an agent ready across an
occupied native slot.

## Native HTTP and C03 control

The existing `POST /agent/calls/:callId/end` and
`POST /agent/calls/:callId/drop-voicemail` accept optional `intent`:

```json
{
  "intent": {
    "deskSessionId": "11111111-1111-4111-8111-111111111111",
    "expectedRevision": "1",
    "bindingGeneration": "1",
    "idempotencyKey": "22222222-2222-4222-8222-222222222222"
  }
}
```

`native-call-control.ts` checks authenticated active user/auth version,
controlling Desk lease using database time, revision, verified binding, current
owner, concrete participation and full reservation under admission. Pause or a
call-start maintenance stop does not prevent cleanup. Unresolved commands and
open transfers refuse a fresh control claim. No browser-supplied actor, UUID,
recording or command determines execution.

Admission atomically persists fixed command/job UUIDs, immutable targets, parent
operation identities, reservation snapshot and audit. A successful HTTP response
is `CallControlResponse`:
`{status: "accepted", callId, operationId, revision}`. It acknowledges durable
acceptance, not media/cleanup success. Replay returns the same identity without
another wake/send, including after terminal completion or a newer slot. Changed
intent under the same key returns `idempotency_conflict`. A scheduler-wake failure
retains committed work. Recovery must schedule the persisted root, rather than
submit a new intent/key.

`nativeCallControlExecutor` follows the persisted dependency chain through C03.
End kills exact customer/agent legs in order. Voicemail first transfers the exact
customer to `voicemail_native:<callId>:<server-selected-path>`; the repo-owned XML
captures the immutable call/audio snapshot and enters the existing playback
flow. This single transfer avoids a partially completed multi-command setvar
sequence. Campaign audio is selected under its existing lock and retained after
assignment changes; there is no global fallback. Paths must be absolute literal
paths compatible with the dialplan destination, without spaces or traversal.

The dependent `release_agent` cannot execute before the transfer succeeds. Each
operation has one physical send on an abortable authenticated socket with a fixed
Job-UUID. ACK is insufficient. The verifier requires the completed matching job
and persisted exact playback/terminal effect. Trusted BACKGROUND_JOB evidence is
also retained by the normal ESL adapter, allowing reconciliation after lost
responses without resending. Without job evidence the result stays uncertain,
even if a probe says the target is missing. Verifier persistence/probes reuse the
executor's leased PostgreSQL connection; no second executor connection is taken.

A definitive transfer rejection cancels the never-sent dependent release and
restores the interactive call state while retaining its occupied reservation.
A fresh control claim is possible; it does not reuse the failed operation. Event
uniqueness cannot prevent that retry. An uncertain operation is never canceled
as an unstarted command or changed back to pending.

Confirmed agent cleanup frees only its old slot/browser capacity, writes
`agent_released` and permits new interactive admission while the customer plays.
Later playback completion/customer hangup cannot release the new slot, change its
operation/contact/capacity, or clear pause, in either event order.

## Compatibility and remaining rollout gates

`registerDashboardRoutes` accepts an explicit native-control executor dependency.
`server.ts` does not install it: v1 controls fail with 409
`coordination_unavailable` before mutation when absent. Existing missing-intent
legacy behavior remains, and native histories cannot fall through to raw legacy
`uuid_transfer`/`uuid_kill`, optimistic finalization, watchdog or reconnect repair.
No product ingress, Desk UI, provider configuration or production activation is
introduced. This follows the same staged integration boundary as C04/C05.

D/E/G own connection/transfer media decisions; H01 owns restart scheduling and
broader sender recovery; I05 owns bootstrap, drain/rollback and enablement.
The actual transferred-call FreeSWITCH regression is explicitly assigned to G02
by C06.3. None of these gates is reported as completed by C06.

## Verification and evidence levels

The existing seven `call-cleanup.integration.test.ts` cases use real PostgreSQL,
separate workers/backends, held commit/rollback and mandatory
`pg_blocking_pids` assertions. They cover admission/cleanup ordering, resolution
versus cleanup, reservation ABA, replay, terminal correction and changed owners.

Seven `native-call-control.integration.test.ts` cases use actual authenticated
Fastify routes, real PostgreSQL and C03 with a simulated ESL peer: auth/CSRF,
absent bootstrap, stale authority, response-loss replay, uncertain work, recording
snapshot, pause, end before/after answer, dependency order, rejection/fresh retry,
old failed-chain replay against a newer claim, and ACK/job without
concrete cleanup followed by reconciliation. These are DB/API contract tests,
not actual FreeSWITCH or provider proof.

`npm run test:cleanup:freeswitch` runs pinned FreeSWITCH 1.10.12 and PostgreSQL 17
in private disposable containers with no published ports, application `.env`,
`DATABASE_URL` or provider access. The expanded lab exercises actual HTTP routes,
the product native producer/driver/executor, genuine ESL frames and cleanup:

- C06.1: delayed originate bytes, missing UUID, lost response, exact job,
  quiescence and cleanup once; native API hangup and no duplicate jobs.
- C06.2: real SIP answer/bridge, decoded 440/880 Hz bidirectional PCMU, repo-owned
  voicemail XML and decoded 660 Hz WAV; agent release while customer is live,
  new real media legs/reservation, pause, old completion/hangup in both orders,
  duplicate HTTP/event replay and zero remaining FS channels.
- Native transfer response loss: TCP relay holds the command then drops the
  response. The independent ESL observer retains the exact completed job;
  a replacement adapter reconciles it and sends only the dependent release.
- C06.3: DB late-event/manual-correction/ownership matrix above; G02 retains its
  explicitly deferred actual transferred-call runtime regression.

Fixture admission and verified Desk state are test setup; SIP endpoints are local
UDP/PCMU peers. This is realistic FreeSWITCH call-path evidence, not browser
WebRTC, provider mailbox receipt, hosted CI, target storage/load/soak, deployment,
rollback or production acceptance. Artifacts retain source hashes, versions,
commands/events, SQL snapshots, decoded tones and cleanup evidence.

The isolated DB runner bounds WAL with `max_wal_size=64MB` and
`min_wal_size=32MB`. PostgreSQL's default WAL growth exhausted the 256 MiB tmpfs
in an intermediate full-quality run (`PANIC: could not write to file
"pg_wal/xlogtemp.974": No space left on device`); that run is a failure, not passing
evidence. Fsync/synchronous commit, test assertions and product settings remain
unchanged. tmpfs/checkpoint timings are not target-storage or crash-durability proof.

## Verified local result — 2026-11-15

All final commands exited 0 on Node.js 23.7.0 (required >=22). Changes remain local
and uncommitted on `feat/c06-native-call-controls`, based on `02eca6618ce4900013e4f5472de5791ea17eac06`.

| Command / environment                                                                                                                             | Result / retained local artifacts                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INBOUND_PG_STORAGE=tmpfs bash /tmp/c06-quality-pg16.sh`                                                                                          | PASS: `npm run quality`, PostgreSQL 16.16; OpenAPI, lint, formatting, types, 357 API tests with zero skips, 135 web tests, 76 ops tests and all builds. `/tmp/outbound-inbound-db.LgMx8hh6/`.                                                      |
| `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`                                                                                       | PASS: PostgreSQL 17.11, 63/63 DB tests, zero skips, including seven native-control and seven cleanup tests. `/tmp/outbound-inbound-db.Gdi4FvoX/`.                                                                                                  |
| `npm run test:cleanup:freeswitch`                                                                                                                 | PASS: pinned FreeSWITCH 1.10.12 and PostgreSQL 17.11; all seven complete scenario groups and three additional decoded-media measurements. `/tmp/outbound-c06.i9RhCURe/`, including source hashes, report, real events, command ledger and cleanup. |
| `npm run test:voicemail:db`                                                                                                                       | PASS: 8/8 legacy DB/API regressions, zero skips; simulated ESL. `/tmp/c06-native-voicemail-final.txt`.                                                                                                                                             |
| `sha256sum -c /tmp/outbound-c06.i9RhCURe/source-sha256.txt`; `bash -n scripts/test-c06-cleanup.sh scripts/test-inbound-db.sh`; `git diff --check` | PASS.                                                                                                                                                                                                                                              |

The PG16 wrapper derives from `scripts/test-inbound-db.sh`, substitutes the cached
PG16 digest `sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`,
resolves the repository root explicitly, and runs `timeout 300 npm run quality`.
It uses the same bounded WAL settings as the PG17 runner. Disposable containers,
roles, schemas and workers were removed/reaped. Artifacts are temporary local
files, not hosted uploads.

C06.1–C06.3 have their required local DB/FS evidence within the issue's stated
scope. The G02 transferred-call runtime regression and the browser/provider,
load/soak, hosted-CI, target-storage, deployment/drain/rollback and production gates
remain separate and unrun here. No commit, push, PR or deployment occurred.
