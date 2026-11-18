# G04 — Post-transfer control, telemetry and supervision

Task: [G04 #37](https://github.com/sptmru/outbound-freeswitch-dialer/issues/37).
Base: `7d25eca`; branch `feat/g04-post-transfer-boundaries`. Changes are local,
uncommitted and undeployed. Native bootstrap/enablement remains I05.

## Control authority

Only the current `calls.agent_id`, matching live Desk controller, concrete
participant and fenced slot can admit native hangup, voicemail or DTMF. Transfer
create/cancel/target actions retain G01's equivalent checks. Admission and C03
execution revalidate durable ownership; browser state never grants permission.
Former/unrelated actors and wrong Desk revisions have no mutation or send effect.
A replay of a previously authorized request can return its historical receipt;
it does not grant a new control action or another send after handover.

`POST /agent/calls/:callId/dtmf` now accepts optional `intent: DeskMutationRequest`
alongside `digit` and `campaignId`. With intent it returns `CallControlResponse`;
without intent it retains the ordinary legacy outbound response. Native calls
refuse legacy DTMF, hangup and voicemail paths. The staged native adapter is still
required. Agent Desk supplies its current controller/slot for all three controls
and refetches after an accepted operation instead of treating it as a Desk snapshot.

Migration `044_native_dtmf.sql` adds `send_dtmf` to the immutable C03 command
vocabulary. One fixed Job-UUID targets the exact customer leg with one validated
digit. DTMF does not move the interactive slot to releasing. Missing job evidence
retains uncertainty and cannot cause a resend. A successful completed job records
local command completion, not far-end reception. Existing feature-off calls and
request shapes remain supported. Older native workers cannot consume this new
command kind; mixed native worker activation remains excluded until I05.

## Participation telemetry

`PUT /agent/calls/:callId/legs/:legUuid/browser-media` accepts the existing
`BrowserMediaTelemetryRequest` body. `legUuid` is the exact FreeSWITCH agent UUID
from `X-Outbound-Dialer-Leg-ID`, not a role, current owner or browser-supplied
participant reassignment. The server resolves its same-call participant and
checks the authenticated user. The browser retains that identity for periodic
uploads and the final asynchronous upload after ownership changes.

The interval must be inside the participant's known `joined_at`/`left_at` and
leg end, and cannot end in the future. Missing/mismatched participation or an
out-of-bounds sample returns 404; invalid shape/reversed interval returns 400.
A former owner may submit a delayed valid summary for their own participation.
An overlapping summary is rejected, not attributed to the recipient or clipped
into a different participation. No participant timing or duration is changed.
The participant row lock serializes interval validation with handover closure.

Concrete statistics remain keyed by participant, so A → B → A has separate
summaries. Only a strictly greater sample count updates cumulative metrics;
equal-count, conflicting duplicate and older summaries are inert. The ordinary
call-only route continues to refuse inbound/native histories. H03 owns history
presentation/analytics and avoiding double-counting legacy projections.

## Explicit supervisor handover policy

The selected policy ends all native supervision before the transfer's first
physical preparation/originate/switch. Pending/declined offers preserve existing
supervision; fresh starts/mode replacements are blocked while any transfer is open.
After completion a new explicit monitoring request is allowed against the current
owner's live leg and always starts in `listen`, even after whisper/join.
An old session never acquires the recipient's leg.

The transfer executor, under common admission, cancels only unstarted supervisor
operations, journals one exact-generation hangup, and executes/reconciles through
C03 critical seats outside the transaction. Already uncertain start/mode/stop work
must first resolve its original fixed job. No timeout/ACK/absence-only probe frees
the session. Every generation needs terminal channel evidence plus sender
completion. Until then, transfer commands remain pending, source media and both
agent reservations remain intact, and supervisor capacity remains counted.

`releaseSupervisor` releases only a native `supervisor_channel` permit whose exact
session has no live generation and no unresolved sender. It does not wait for
unrelated pending transfer operations on the same call: doing so would deadlock
handover. General call-capacity release keeps its existing conservative rule.
Legacy supervisor sessions still block native transfer execution until their own
teardown completes; G04 does not invent fixed-job evidence for a legacy sender.

## Acceptance and reproduction

Use Node.js 22+; each DB/FS command creates disposable test resources and reads no
application `.env` or database. The FS harness uses pinned FreeSWITCH 1.10.12 and
PostgreSQL 17 with network-none local SIP/PCMU endpoints and decoded audio.

```bash
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN='G04|C07' npm run test:inbound:db:isolated
npm run test:transfers:boundaries:freeswitch
npm --workspace @outbound-dialer/web test -- src/features/agent-desk/agent-desk-transfers.test.tsx
npm run quality
git diff --check
```

| Criterion | Coverage                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G04.1     | Authenticated API + real PostgreSQL for inbound/outbound post-handover end/voicemail/DTMF/transfer; former and unrelated users, stale controller/revision, inert historical replay and no denial side effects. Existing C06 covers source controls before handover. Component tests check current authority and accepted-operation refetch.                                   |
| G04.2     | Authenticated delayed telemetry for the exact old participation, wrong actor/customer/recipient/unknown leg, invalid/past-end/future intervals, duplicate/conflicting/older summary, unchanged participation duration and refused legacy route.                                                                                                                               |
| G04.3     | Real PostgreSQL start/transfer commit orders and rollback with `pg_blocking_pids`; pending mode cancellation; channel-end/job-completion orders and retained uncertainty/capacity. Actual FS whisper/join before both-direction A → B → A, exact teardown before owner switch, no old-supervisor tone on recipient, fresh listen-first session and reserved-capacity cleanup. |

Local results/artifacts are recorded below after validation. Component and DB
checks use simulated media/effects. Actual FS checks seed admin/Desk/registration
and initial outbound conversation fixtures; they are separate from integrated
browser WebRTC, provider/far-end, load/soak, target storage, deployment, rollback
and production acceptance. I01–I05 remain independent gates.

## Verified local result — 2026-11-18

G04.1–G04.3 passed at their specified API/DB/FS levels. Environment: Node 22.13.0,
PostgreSQL 17.11 tmpfs, FreeSWITCH 1.10.12, static ffmpeg/ffprobe 7.0.2. Base
`7d25eca9b9ec8f167883b92cb9c60010ea91aba3`; no new commit or hosted CI run.

| Command                                                                                                                                                | Result and retained evidence                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATH=/tmp/node-v22.13.0-linux-x64/bin:$PATH INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN='G04\|C07' npm run test:inbound:db:isolated`                | Passed: 14 substantive G04 tests and 8 C07 regressions. TAP reports 47 total because 25 unmatched files are discovery containers; those are not additional acceptance scenarios. `/tmp/outbound-inbound-db.KenocNja/result.txt`.                                                                                                                                                 |
| `PATH=/tmp/node-v22.13.0-linux-x64/bin:$PATH npm run test:transfers:boundaries:freeswitch`                                                             | Passed: 50 G04/G02/E02 groups. `/tmp/outbound-e02.mCxAaqlg/report.json`; decoded two-way media, both directions and A → B → A, whisper/join teardown, new explicit listen sessions, four actual fixed DTMF jobs, source loss and cleanup regressions. Final snapshot has zero unresolved operations, occupied slots, live legs or unreleased capacity. Owned containers removed. |
| `PATH=/tmp/f02-ffmpeg:/tmp/node-v22.13.0-linux-x64/bin:$PATH INBOUND_PG_STORAGE=tmpfs bash /tmp/vscode-agent-codex-sandbox-pnhDqw/g04-quality-pg17.sh` | Passed full `npm run quality`: OpenAPI, lint, formatting, typecheck, 518 API / 206 web / 78 ops tests, zero skips, all builds. Wrapper reuses the repository's disposable PG runner and substitutes `npm run quality`; retained wrapper and result: `/tmp/outbound-inbound-db.7Sj1cDdB/runner.sh`, `result.txt`.                                                                 |
| `PATH=/tmp/node-v22.13.0-linux-x64/bin:$PATH npm run test:voicemail:db`                                                                                | Passed: 8/8, zero skips, separate isolated PostgreSQL 16 regression. `/tmp/g04-voicemail-result.txt`.                                                                                                                                                                                                                                                                            |
| Focused web component and softphone lifecycle suites                                                                                                   | Passed: 22 transfer/control component tests and 20 softphone lifecycle tests, including exact-leg final telemetry. Both are included in the final full quality gate.                                                                                                                                                                                                             |
| `git diff --check`                                                                                                                                     | Passed.                                                                                                                                                                                                                                                                                                                                                                          |

The first full quality attempt failed only two pre-existing F02 audio tests because
`ffmpeg` was absent from PATH (`spawn ffmpeg ENOENT` / decoder 503). Existing local
static tools under `/tmp/f02-ffmpeg` resolved the environment; the final full gate
above passed. Initial missing FS image was fetched at the exact pinned digest;
no running product service was changed. Earlier failed fixture iterations are
not counted as passing evidence. The FS helper received formatting-only changes
after its successful runtime run; all application source hashes match that run,
and final formatting/lint checks passed.

Integrated browser WebRTC, provider/far-end reception, load/soak, target disk
performance, deployment/rollback and production acceptance remain unrun I01–I05
gates. No commit, push, PR, deployment, provider call or production mutation occurred.
