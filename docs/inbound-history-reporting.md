# H03: inbound and transfer history and reporting

H03 extends the existing administrator history and analytics routes. It does not
enable native admission, routing, executors or browser media. I05 still owns that
bootstrap; I01–I05 retain their integrated browser, FS, load and provider gates.

## Read contracts

`GET /admin/calls` and `GET /admin/calls/export.csv` accept optional `direction`
(`inbound` or `outbound`), exact `did`, and `queueId` in addition to the existing
filters. `agentId` remains a **user ID** and matches the current owner or any
historical agent participant, using `EXISTS` rather than multiplying call rows.
Search includes the original DID and calling number. Campaign and queue IDs are
the immutable call origin; display names reflect current library names.

Each history item has additive `context`: direction, original DID, caller/called
number, queue, queue wait, queue exit, terminal reason, latest non-hangup flow
outcome, completed agent conversation time, participant/transfer counts and manual
correction timestamp. Unknown evidence remains null. Queue wait ends at the
persisted queue exit, never at PSTN answer. A fallback exit is `timeout`; a later
successful playback or external connection is a separate flow outcome. Offer
Ignore, expiry, manual dismissal and transfer decline do not classify the customer.

`GET /admin/calls/:callId` adds `journey`, with separately counted participant,
offer, transfer and fallback-operation pages. Each page includes the first 200
items in stable order, `total` and `truncated`. The UI and CSV explicitly report
omission. The existing technical event timeline remains the latest 100 events.
Journey rows project identifiers, lifecycle facts and bounded metrics, never raw
command requests, SIP payloads, credentials or storage paths. Leg keys use concrete
leg IDs, including external legs and repeated visits by the same agent.

Native RTP/browser summaries are shown on the matching participant/leg; a legacy
call-level browser/media projection is suppressed for native lifecycles. Missing
native evidence does not borrow a final owner's or an old leg's summary. Legacy
ordinary outbound readers retain their existing projections.

## Analytics and exports

Existing attempts, daily funnel, campaign/agent performance, voicemail and legacy
media quality reports cover **outbound** calls. Native outbound attempts belong to
the earliest agent participant, falling back to the stored owner for legacy calls.
The legacy agent performance average describes the conversations on those initiated
calls; it is not that agent's personal talk time. Native conversation averages use
the union of completed agent/external connected intervals; ordinary legacy outbound
retains its answer-to-end proxy.

Additive `inbound` analytics count product calls once, agent connections, fallback
queue exits, mean evidenced queue wait and transfer attempts. `participation`
attributes completed time to each agent and direction, unions overlapping intervals,
and counts distinct calls and concrete RTP/browser segments. Intervals require both
connection and departure evidence and are clipped to call end. Live/unclosed
intervals are excluded. Do not sum per-agent call counts into product call totals.
These are database facts, not a claim about audible speech or human contact.

CSV retains its original leading columns, appends call identity/context and JSON
participant/offer/transfer/flow-step projections with a truncation flag, and preserves
the bounded keyset export and spreadsheet escaping. It streams one call at a time
without reserving a connection for the download. The row keyset is fixed at export
start; lifecycle details remain live reads, not a transaction-wide historical snapshot.

Campaign recording ZIP continues to select by fixed campaign only, independently of
other history filters. Its manifest adds direction, DID, queue ID, agent conversation
time and transfer count. It keeps one WAV per call, canonical-path checks and existing
admin-only playback/ticket/range authorization. H02 owns recording content and its
outstanding human listening gate; H04 owns the wider retention/restore audit.

## Verification

The H03 DB/API suite uses isolated PostgreSQL and synthetic persisted history:

```bash
PATH=/tmp/node-v22.13.0-linux-x64/bin:$PATH \
  INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN=H03 npm run test:inbound:db:isolated
npm run test:history:browser
npm run quality
git diff --check
```

- H03.1: ignored/expired/manually dismissed inbound offers, accepted other recipient,
  manual transfer decline, queue timeout followed by successful audio or forwarding,
  and unchanged live source history.
- H03.2: inbound/outbound A–B–A, overlapping evidence, an external interval, null
  initial owner/contact, concrete media, one call/page row and exact duration/attempt
  attribution. These are reporting fixtures, not a telephony race test.
- H03.3: authenticated history/detail/filter/CSV parity, denied agents, invalid
  filters, manual correction and late duplicated terminal events; Chromium renders
  real HistoryView with a controlled API, queue/DID/direction/agent filtering,
  participation, recording player and CSV download. Media/API are fixtures.

The full quality and existing playback/ZIP/outbound regressions are required before
completion. Local test success supplies no provider, real browser WebRTC, deployment,
production, load or hosted-CI proof.

## Local results — 2026-11-18

Base `21093df6ddda8a573c1b1dc3960ea9495ab9a495`, branch
`feat/h03-inbound-history`. Changes are local and uncommitted.

| Check                                                                    | Result                                                                                                                                 | Local artifact                                                               |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Focused H03/B03 `test:inbound:db:isolated` run                           | Seven substantive H03/B03 DB/API cases passed; 30 unmatched file wrappers are not extra acceptance cases                               | `/tmp/outbound-inbound-db.OQksccqG/`                                         |
| `INBOUND_PG_STORAGE=tmpfs bash logs/h03-quality.sh`                      | Entire `npm run quality` passed: OpenAPI, lint, format, typechecks, 551 API / zero skips, 206 web, 78 operational tests and all builds | `/tmp/outbound-inbound-db.RsR2s3op/result.txt`, `logs/h03-quality-clean.log` |
| `npm run test:history:browser`                                           | 1/1 Chromium journey passed, including queue/DID/direction/agent filters, actual fixture WAV decode/play and downloaded CSV bytes      | `logs/h03-browser-final.log`                                                 |
| `npm run test:e2e -- tests/e2e/history-recording-export.spec.ts`         | 1/1 existing Chromium ZIP/error regression passed against the rebuilt web                                                              | `logs/h03-recording-export-browser.log`                                      |
| `git diff --check`, final source hashes, focused browser ESLint/Prettier | Passed                                                                                                                                 | `logs/h03-final-source-sha256.txt`                                           |

The focused command was:

```bash
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN='H03|B03.1' npm run test:inbound:db:isolated
```

Completion evidence is posted in [H03 #40](https://github.com/sptmru/outbound-freeswitch-dialer/issues/40#issuecomment-6974950892); the issue is closed and its tracker item is checked. H02 remains open.

The quality wrapper is a local copy of the existing isolated DB runner, replacing
only repository-root resolution and the final command with `npm run quality`
under a 900-second outer watchdog. It uses a separate socket-only, network-none
PostgreSQL 17 tmpfs container with no published ports and unsets `DATABASE_URL`.
Node 22.13.0 and the existing local ffmpeg/ffprobe were on PATH. Temporary caches
use `logs/h03-tmp/node_modules` to avoid the almost-full host `/tmp` and repository
lint discovery of generated Playwright cache JavaScript.

An initial gate exposed the B03 test's current reader executing against an
unmigrated 026 schema. That test now verifies retained legacy columns and API
fields after required migrations. A subsequent run observed `write EPIPE` in the
unchanged C03 lost-lock worker test; its isolated recheck passed at
`/tmp/outbound-inbound-db.8xw5q5zW/`, and the final complete gate passed without that
failure. No C03 source or timeout was changed. The final browser fixture also
corrects its relative media-ticket URL and checks decoding/playback, not just an
audio element's presence.

H03.1–H03.3 are complete at their required DB/API/B reporting levels. No real
browser WebRTC, FS call path, provider, load, hosted CI, deployment/rollback or
production acceptance is claimed. H02's human listening gate remains open.
