# Customer recording continuity and eligibility (H02)

The call keeps one canonical `CALL_RECORDINGS_STORAGE_DIR/<callId>.wav` and one
customer-leg recorder across ownership changes, repeated transfers and external
forwarding. `calls.campaign_id` remains fixed. Inbound snapshots
`campaigns.call_recording_enabled` at its first durable import, just as outbound
fixes recording policy when its call is created. Later campaign edits and replayed
imports do not change an existing call's policy.

## Media boundary and single startup

- Outbound starts on confirmed customer `CHANNEL_PROGRESS_MEDIA`, `CHANNEL_ANSWER`
  or `CHANNEL_BRIDGE`. The existing early-media policy is preserved.
- Inbound starts on confirmed customer answer, including answered queue waiting,
  waiting audio, fallback audio and external conversation. Pre-answer ingress and
  rejected/pre-media calls have no required recording segment. The durable waiting
  event is an additional startup opportunity if the earlier answer preceded import.
- Recording dispatch follows committed lifecycle evidence, including the specialized
  inbound, coordinated outbound and transfer handlers. It validates the concrete
  UUID against the live `customer` row in `call_legs`; agent, supervisor, external,
  unrelated and ended legs cannot claim a recorder.
- A conditional `pending` -> `recording` update claims the single path before any
  filesystem/ESL operation. Duplicate/concurrent events and handovers cannot claim
  a second start. No recorder is started per agent or external participant.
- A rejected command produces `call_recording_failed`. An ambiguous send produces
  `call_recording_start_uncertain` and retains the path/claim. Neither clears the
  path or retries `uuid_record start`, which could truncate a successful recorder.
  A crash after claiming but before send can lose the recording; finalization then
  reports missing expected output. This preserves truthful failure instead of
  promising recovery of audio that was never captured.

## Finalization and access

The finalizer waits for a terminal call and customer-leg cleanup before inspecting
its file. It retains claim-token fencing, stale-claim recovery and one finalization
event. Owner changes cannot change the path or campaign.

For enabled terminal calls with no path, persisted customer answer/early-media/
bridge evidence distinguishes a required missing recording (`failed`,
`call_recording_integrity_failed`) from no eligible customer media (`disabled`,
`call_recording_not_applicable`, no failure reason). Here `disabled` describes media
availability; the frozen `call_recording_enabled` policy remains unchanged. Queued
abandonment before answer is not a failure; abandonment during answered waiting
requires a recording under this policy. Missing, empty or corrupt expected output
remains a genuine failure, even if the call itself failed or media was interrupted.
Historical failure rows are not rewritten automatically.

Playback, tickets and campaign ZIP export retain their existing admin-only policy.
A former, current or unrelated agent does not acquire playback access through call
ownership or participation. Ticket validation rechecks the issuing user's active
admin role. Range streaming and export keep the same call ID, canonical path and
fixed campaign. Ordinary retention preserves a recent recording and its call row;
H04 owns the broader durable-work retention/backup audit.

## Verification

```bash
# Node >=22 and ffprobe on PATH (or set FFPROBE_PATH); isolated PG17, no app DB/ports.
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN=H02 npm run test:inbound:db:isolated
npm run test:recording:transfers:freeswitch
npm run test:recording:forwarding:freeswitch
# Optional focused forwarding case; omit for all F04 failure/continuation cases.
F04_SCENARIO=answered npm run test:recording:forwarding:freeswitch
npm run quality
npm run test:voicemail:db
git diff --check
```

The DB/API matrix covers pre-media cancellation, queued abandonment, disabled
recording, missing startup/output, corrupt output, interrupted playable output,
concurrent/replayed starts and finalization, ambiguous send, exact UUID selection,
policy freeze, owner changes, admin/agent access, tickets, byte ranges, campaign ZIP
bytes and retained references. The missing/empty/corrupt/valid file matrix uses
real filesystem inspection and ffprobe. Concurrency/access-only fixtures explicitly
inject inspection; real FS WAV parsing and ffprobe finalization independently
verify playable PCM, marked content and idempotent finalization.

The FS runners reuse isolated product-entrypoint E02/G02 and D04/F04 fixtures. They
start recording through the product ESL adapter, check one customer media bug and
one startup event, retain WAV files, and decode marked windows before/after A-B-A
transfers and waiting/external conversation. Both inbound and outbound transfers
are covered. Source initialization and Desk endpoint verification retain the
explicit fixture boundaries of those runners. No browser/provider/deployment or
production acceptance is implied.

**H02.1 also requires human listening to representative retained WAVs.** Automated
PCM checks do not satisfy that manual check. Keep H02 open until a listener and
result are recorded. The issue handoff records current commands, outcomes,
artifacts and any remaining gates. I01-I05 still own integrated browser, full
failure/load/provider and target enablement acceptance.

## Local verification record — 2026-11-18

Branch: `feat/h02-recording-continuity`, base
`5feb883477ac92b9e2501c733b198a22bd99a676`; changes remain local and uncommitted.

| Criterion | Verified evidence                                                                                                                                                                                          | Remaining requirement                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| H02.1     | 20/20 E02/G02 groups and 27/27 F04/D04 groups, including real inbound/outbound A-B-A, one recorder, phase-specific PCM markers, ffprobe and duplicate finalization; 7/7 C06 FS regressions                 | Human listening to representative retained WAVs                       |
| H02.2     | Nine-case real filesystem/ffprobe DB matrix plus startup concurrency, exact UUID, live-customer finalization guard, terminal-first import and policy replay                                                | No task-specific automatic check deferred                             |
| H02.3     | Actual authenticated API/PG: admin playback, nonempty byte ranges, ticket streaming/revoked issuer, ZIP contents, denied former/current/unrelated agents, retained call/campaign/path and finalizer replay | Broader H04 retention/backup and I01-I05 target gates remain separate |

Final FS artifacts (reports include image digests, commands, source hashes and
persisted state): `/tmp/outbound-e02.uB6QLh4I`, `/tmp/outbound-d04.GHuFDSD1`,
`/tmp/outbound-c06.nfX3PuzA`. Dedicated initial H02 DB/API execution:
`/tmp/outbound-inbound-db.IOrnyisA`; the final real-file matrix also runs in the
full quality gate. Voicemail PostgreSQL regression: 8/8, zero skips.

Representative files awaiting a human listener:

| Journey                                 | WAV                                                                              | Duration | Automated marker checks                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| Inbound A-B-A                           | `/tmp/outbound-e02.uB6QLh4I/recordings/6e0b6c7d-3d91-441e-8353-9b17e4cebf9f.wav` | 17.50 s  | Source 660 + customer 880 Hz; recipient 440 + customer 880 Hz; returned source 660 + customer 880 Hz |
| Outbound A-B-A                          | `/tmp/outbound-e02.uB6QLh4I/recordings/a3d12380-1ba5-41e4-9704-d85055cdaf74.wav` | 16.40 s  | Same three phase-specific pairs                                                                      |
| Answered waiting to external forwarding | `/tmp/outbound-d04.GHuFDSD1/recordings/2b6f83e0-4232-4071-9421-16aa9fd2d756.wav` | 35.76 s  | Waiting 440 Hz, then customer 440 + external 880 Hz                                                  |

These are synthetic local SIP endpoints. The full transfer source-loss matrix,
browser/WebRTC, provider, load, hosted CI, deployment, rollback and production
acceptance were not run as part of H02. The task is not closed and its tracker
checkbox remains unchecked until mandatory human listening is documented.

Full `npm run quality` passed on Node 22.13.0 with isolated PostgreSQL 17.11
(tmpfs): 548 API tests, zero skips; 206 web tests; 78 operational tests; OpenAPI,
lint, formatting, typecheck and all production builds passed. The isolated wrapper
and exact output are retained in `logs/h02-quality.sh`, `logs/h02-quality.log` and
`/tmp/outbound-inbound-db.HCin0zKl/result.txt`. `FFPROBE_PATH` and `FFMPEG_PATH`
pointed to the existing local `/tmp/f02-ffmpeg/` binaries; no dependencies were
installed. Final source-hash checks match both FS manifests and the quality
manifest; documentation formatting and `git diff --check` passed after the
acceptance record was updated. Tmpfs results do not establish target-storage
performance. No issue/tracker completion, commit, push, PR or deployment occurred.
