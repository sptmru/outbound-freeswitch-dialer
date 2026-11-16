# B01 — Inbound routing configuration schema

Task: [B01 #9](https://github.com/sptmru/outbound-freeswitch-dialer/issues/9).
Base: `f4ae996d86e054e1ce1334d5d416019da2dd28ce` (`dev`).
Branch: `feat/b01-inbound-routing-schema`.

Migration `025_inbound_routing.sql` adds configuration only. It seeds no numbers,
queues or flows and changes no existing calls, states, campaign voicemail assignments,
API routes, shared contracts, environment variables or FreeSWITCH configuration.
New numbers default to `enabled=false`, `desired_revision=1`, `applied_revision=NULL`.
Inbound delivery, provider acceptance and target enablement remain separate D/I gates.

## Entities and ownership

- `inbound_numbers`: unique `normalized_did`, label, queue and enabled flag. Several
  DIDs can share one queue. Store canonical international numbers only. The DB checks
  canonical shape and uniqueness; `normalizeInboundNumber` reuses existing normalization
  **and strict libphonenumber validation** before persistence. DB syntax alone does
  not establish a valid or provider-owned number. Provider DID extraction stays D02/I04.
- `inbound_queues`: campaign, optional waiting audio, selected immutable no-answer
  flow version, separate offer/queue/connect/transfer deadlines, waiting-call limit
  and `reject` or `flow` overflow policy. The flow policy requires a version reference;
  reject forbids one. All audio/flow references must belong to the queue campaign.
  Queue membership continues to follow the campaign selected in Desk; no membership
  table or dispatcher is introduced here.
- `inbound_flows`: named campaign-owned identity. `inbound_flow_versions` records a
  positive unique version per flow, fixed ID, ordered `actions`, total duration and
  creation time. Composite FKs enforce campaign ownership. Saved rows reject every
  UPDATE and DELETE; future H04 retention needs an explicit guarded policy rather
  than bypassing that protection. Deleting a referenced campaign/asset is restricted.
- Both numbers and queues record desired/applied revisions. A material edit advances
  desired by one and retains the previously applied revision. A combined edit cannot
  claim its own application. A separate apply acknowledgement may advance applied up
  to desired. Client-written desired revisions are ignored on UPDATE. These fields
  store evidence; D02 must still implement aggregate number/queue revision correlation,
  stale-ack checks and actual FS application. Saving a row never proves application.

Queue defaults and ranges follow [A06](inbound-resource-budgets.md):

| Column                | Default | Inclusive range                          |
| --------------------- | ------- | ---------------------------------------- |
| `offer_timeout_ms`    | 15000   | 5000–30000                               |
| `queue_timeout_ms`    | 60000   | 15000–300000                             |
| `connect_timeout_ms`  | 10000   | 6000–15000, strictly below queue timeout |
| `transfer_timeout_ms` | 20000   | 5000–30000                               |
| `max_waiting_calls`   | 40      | 1–200                                    |

Milliseconds and call permits are distinct units. These are configuration bounds;
C02/D02 still enforce aggregate DB/FS resource accounting, pre-admission limits and
reserved capacity. Lowering a saved limit does not manipulate any admitted call.

## Immutable flow contract

`actions` contains 1–3 objects. Unknown fields/types, jumps and nested flows are
rejected. There are at most two `play_audio` actions and one `forward_external`.

```json
[
  { "type": "play_audio", "recordingId": "11111111-1111-4111-8111-111111111111", "timeoutMs": 30000 },
  { "type": "forward_external", "target": "+14155550100", "timeoutMs": 20000 },
  { "type": "play_audio", "recordingId": "11111111-1111-4111-8111-111111111111", "timeoutMs": 30000 }
]
```

A playback bound is 1000–60000 ms; forwarding is 5000–30000 ms. `hangup` takes no
other fields and must be last if supplied. Exhausting the sequence means hangup;
subsequent actions after a failed forward are its failure continuation. F03/F04 own
execution, success/terminal evidence, cleanup and the no-recursive-overflow rule.
Sum of action bounds must fit `flow_timeout_ms` (default 90000, range 1000–180000).
The deadline also caps execution overhead and cleanup; it is never extended by retries.

On INSERT, the database validates the sequence and locks referenced media rows in ID
order, verifies active campaign ownership and derives `audio_snapshot` with recording
IDs, file/runtime paths and durations. Generated `first_audio_id`/`second_audio_id`
provide real FKs. Later library changes cannot alter saved parameters. A new version
gets a new ID; calls must retain their chosen version rather than follow queue edits.
B03 owns the actual call-side column/FK; B01 tests use a labeled FK fixture joined to
an existing call, without introducing B03 early.

`deleteRecording` returns the existing `in_use` result for flow or queue references,
so it cannot deactivate the record and authorize unlinking its file. Historical flow
versions conservatively pin their audio even after queue reassignment. This protects
the existing deletion path; it does not prove filesystem durability. F02/H04 still
own inbound upload/preview, replacement/deactivation/retention and restore guarantees.
Direct administrative DB/filesystem edits are outside this application guarantee.
F01 must enforce active configuration, owned-DID forwarding loop prevention and
revision conflicts; B05 owns public request/response/error contracts. No new admin
endpoints are implied by the internal Zod schemas in `inbound-configuration.ts`.

## Compatibility and verification

Migrations 001–024 are unchanged. Existing campaign/audio/call reads remain compatible
with the additive schema. New API binaries require migration 025, as with existing
startup migration ordering. Old binaries do not protect new inbound audio references;
keep inbound unused during rollback to those binaries. I05 must determine the supported
rollback binary once all new lifecycle readers and deleters are implemented.

Run:

```bash
npm run test:inbound:db:isolated
npm --workspace @outbound-dialer/api test
npm run quality
git diff --check
```

The dedicated DB runner discovers A07 plus B01 fresh/upgrade suites and fails if its
explicit isolated test DB is missing. Ordinary quality without `TEST_DATABASE_URL`
reports DB skips. The isolated runner uses cached digest-pinned PostgreSQL 17, a
private Unix socket, `--network none` and no published ports. It removes only its
own container/volume and retains reports, source hashes, revision and cleanup logs.
CI uses PostgreSQL 16 separately; local evidence must state the actual version.

- B01.1: real DB DID uniqueness/shared queue, FK/ownership, timeout/limit boundaries,
  overflow and revision constraints; U normalization and configuration boundaries.
- B01.2: v1 snapshot, new v2, immutable update/delete, retained call-reference fixture,
  saved audio/target parameters after library edits, protected deletion path.
- B01.3: fresh product migration runner; exact prior 001–024 schema with representative
  campaign, voicemail asset and call; upgrade and repeated runner; all checksums and
  prior migration rows unchanged; outbound rows unchanged; no seeded/enabled routes.

This is U/DB evidence only. No SIP/RTP, browser, provider, hosted CI or production
acceptance is supplied by these tests.

## Local verification record — 2026-11-14

All changes remain local and uncommitted on the branch above, based on the recorded
base SHA. Node was 23.7.0 (supported requirement: >=22); no hosted Actions run occurred.

| Command / environment                                      | Result and retained evidence                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:inbound:db:isolated` / pinned PG 17.11       | PASS: A07 + B01 fresh/upgrade, 3 tests, no skips; `/tmp/outbound-inbound-db.Perydbyr`                                                                          |
| `bash /tmp/b01-pg16-check.sh` / cached digest-pinned PG 16 | PASS: strict A07/B01 command, then full API suite: 282 tests, no failures/skips; `/tmp/outbound-inbound-db.tON5wPGx`                                           |
| `bash /tmp/b01-pg16-final.sh` / same PG 16                 | PASS after final test changes: strict A07/B01 3/3, standalone B01 2/2 writing into a previously absent evidence directory; `/tmp/outbound-inbound-db.OZ5yNTNl` |
| `npm run quality`                                          | PASS: OpenAPI, lint, format, types, API 269 pass / 3 explicit DB skips, web 135/135, ops 76/76 and all builds; `/tmp/b01-quality-verified.log`                 |
| Focused ESLint/Prettier, `git diff --check`, shell syntax  | PASS after the final test/documentation changes                                                                                                                |

The temporary PG 16 wrappers use the repository's isolated runner setup with image
`postgres@sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`,
then run the commands shown in their retained scripts. They use the same private
socket/test-URL checks, resource limits and deterministic container/volume cleanup;
no application or production database is used. Reports include actual server version,
checksums, preserved rows and assertions. Each test drops and verifies removal of its
schema; each runner records container cleanup. Evidence paths are local artifacts,
not published repository files or hosted CI evidence.

The first sandboxed quality attempt failed because existing ESL unit fixtures could
not listen on `127.0.0.1` (`EPERM`). The successful full run used permission for local
fixture sockets. Initial compilation also exposed a missing TypeScript declaration
for the existing fixture's `databaseConfig`; the declaration is included in this
change. No SIP/provider code was altered to resolve either verification issue.

## F01 administration extension

[Migration 040 and the F01 APIs](inbound-admin-configuration.md) implement the
configuration validation/revision obligations listed above, including owned-DID
loop prevention in either edit order. They add flow enabled/tombstone state and
transactional actor-scoped replay/audit receipts. Saved versions and captured
active-call configuration remain immutable. D02 owns actual application;
F02–F04 own storage/playback/forwarding and I04/I05 provider/activation gates.
