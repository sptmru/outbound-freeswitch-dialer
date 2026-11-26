# E03 — Agent Desk offers and outbound intent UX

Task: [E03 #27](https://github.com/sptmru/outbound-freeswitch-dialer/issues/27).
Base: `26644da2b40cdc0bee29d57c81a6d88442530ead`; local branch
`feat/e03-agent-desk-offers`. Changes remain uncommitted.

## Browser behavior

With a v1 `desk.coordination` snapshot, Agent Desk shows one compact banner
above the workspace with the caller number, campaign, response deadline
countdown, Accept and Ignore. A transfer offer uses the same banner with
Accept and Decline. While the banner is visible, **Start next call** uses
secondary styling. Server
`actions.accept`, `actions.ignore` and `actions.manualStart` control availability;
the browser also requires its exact current, ready D01 session/revision/binding.
A pending offer does not itself occupy the interactive slot or disable manual
next, lead or number controls. Acceptance never follows from a snapshot or ringtone.
The countdown uses the existing offer deadline; it does not invent a caller arrival
or elapsed queue-wait timestamp absent from the contract.

The mounted card owns one bounded-by-deadline audio element, using the selected
speaker where supported. Repeated snapshots do not restart it. Ignore, local
expiry, another winner, a committed manual start or Desk exit stops it. Autoplay
failure leaves visible Accept/Ignore and an explicit **Enable ringtone** action.
Local expiry only hides the expired card and refetches; the server remains expiry
and exclusion authority. Observed closed offer IDs cannot be reopened by delayed
pending snapshots. No SIP invitation is accepted by the card: E04 owns service
INVITE correlation/answering and browser media.

Accept/Ignore use the implemented `/agent/call-offers/:offerId/accept` and
`/agent/call-offers/:offerId/ignore` routes with `DeskMutationRequest`. The same
request identity survives an HTTP-loss retry. An accepted response means
**Connecting…**, never a confirmed conversation. Slot `reserved`/`connecting`
shows connection progress; `uncertain` shows **Checking call connection…**.
Expected conflicts produce actionable status and refetch, without hanging up a
browser dialog or displaying a generic telephony failure. A shared synchronous
request guard bounds duplicate clicks and concurrent local start/accept actions;
only API/PostgreSQL arbitration decides the winner across agents/tabs.

Transfer offers keep valid manual controls available. [G03 transfer controls](inbound-agent-desk-transfers.md) now enable explicit Accept/Decline through the G01 transfer-capable offer routes and add source selection/cancel/progress. The manual start request still performs atomic server-side decline without a separate dismissal.

## Manual and automatic starts

The API client distinguishes legacy `AgentDeskResponse` from native
`started`/`deferred` mutation responses. It refetches after native mutations.
Explicit next, lead and number requests carry `intent.startReason: manual` plus
controller identity and a stable request key; the start request alone performs
server-owned atomic dismissal. Failed admission retains/refetches the card and
preserves manual number input. No separate Ignore/Decline request is sent.

Native automatic work requires a server-owned `autoNextIntent` in `pending` or
`deferred` state. The source call ID and intent ID bind retries; the intent UUID
is a stable alternate request key accepted by C05's source-scoped replay contract.
Retry uses the same source/controller payload every two seconds after deferral,
without outbound ringback. It never falls back to manual. A confirmed `started`
response permits ringback, then refreshes the Desk. Automatic work stops after
started/rejected work; only deferred or locally busy requests get a timer retry.

Campaign/session/revision/binding/source changes, pause, inbound acceptance,
manual action or Desk exit invalidate callbacks. A late response cannot ring
another call after its source/slot changed. Native call disappearance alone never
creates automatic work: inbound completion and handover have no inferred source.
A server-validated outbound voicemail-release source may advance while background
playback remains visible. The fixture checks that consumer behavior; it does not
prove that a real voicemail leg was released.

Legacy responses keep their existing outbound flow. SSE refresh hints now include
Desk sessions, slots, offers, exclusions, transfers and auto intents, and reconnect
refetches. Request sequencing and canonical bigint revision comparison reject
older snapshots without rounding PostgreSQL revisions through JavaScript numbers.

## Staged integration boundary

The standard `buildAgentDeskResponse`/`server.ts` still does not publish
`desk.coordination` or install native admission/connection executors. Native
initial auto-source production and snapshot publication must be wired together
with admission, controller lifecycle and execution under I05, with H01's recovery
gates. E03 consumes the existing server-bound intent contract; it does not create
source work from an ambiguous legacy call disappearance or enable native routing.

E03 verifies the browser consumer at the requested U/B levels. Browser tests use
the real Agent Desk component and HTTP client with a stateful simulated HTTP
server, a simulated ready controller and instrumented media methods. This is not
a full App + real authenticated API integration or SIP/WebRTC/FS/RTP test. E04 and
I01–I05 retain those separate integration, runtime and enablement obligations.
The default app remains on its legacy feature-off path until the staged bootstrap
publishes coordination. No production, provider, configuration, port-publication
or deployment change is included.

## Verification

```bash
npm --workspace @outbound-dialer/web test
npm run test:desk:offers:browser
npm run quality
git diff --check
```

`test:desk:offers:browser` starts a loopback-only test Vite server on port 4175
using `tests/fixtures/e03/vite.config.ts` (`envDir: false`, no `.env`, no API proxy)
and Chromium. The HTML/React fixture is outside the production web root/build.
The regular preview-based Playwright configuration excludes this fixture suite;
run its dedicated command. It uses no credentials, SIP endpoints or provider.
Failures retain traces/screenshots under `/tmp/e03-browser-results/`.

| Criterion | Local evidence                                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E03.1     | Unit/component and App SSE/reconnect tests; browser repeated snapshots, autoplay rejection/retry, keyboard Ignore, deadline expiry, reload, stale closed-card replay, another winner and Desk exit.                              |
| E03.2     | Unit/component manual payload/failed-input/retry checks; twelve browser combinations: inbound/transfer × next/lead/number × success/failure, with held HTTP responses and one start request, no separate dismissal.              |
| E03.3     | Fake timers plus browser stable-source deferral/retry, manual override, revision/campaign/source invalidation, inbound completion without a source, and outbound voicemail-release source fixture with background job preserved. |
| E03.4     | Duplicate click and HTTP-loss replay unit checks; stateful browser two-agent/stale-tab winner/conflict scenario, connection status and usable keyboard/actions.                                                                  |

No real DB, ESL or FreeSWITCH calls are used by these new tests. Existing API/DB
contracts are unchanged. Ordinary `quality` without `TEST_DATABASE_URL` skips DB
integration tests and must not be reported as new concurrency proof. Provider,
real browser audio, hosted CI, target-storage performance, mixed load, restore,
rollback and production acceptance remain in their owning tasks.

## Verified local result — 2026-11-16

- Node.js `v23.7.0` (required >=22).
- `npm run quality`: **PASS**, OpenAPI/lint/format/types/tests/builds; API
  **302 passed, 124 DB skips**, web **169/169**, operations **78/78**.
  Log: `/tmp/e03-quality-final.log`. An earlier run failed on test-only
  Testing Library query typings; the final run includes the corrected queries.
- `npm run test:desk:offers:browser`: **18/18 passed**, Chromium with the
  isolated stateful HTTP/controller/media fixture; `/tmp/e03-browser-final.log`.
- `npm --workspace @outbound-dialer/web test`: **169/169 passed**;
  `/tmp/e03-web-final.log`. The E03 suite includes 16 focused component tests,
  plus the App SSE/revision regression; existing outbound/voicemail tests pass.
- After the final keyboard-focus refinement, focused E03 component tests passed
  **16/16**, web typecheck and focused ESLint passed, and the final Chromium gate
  again passed **18/18**; `/tmp/e03-focused-final.log`.
- `git diff --check` and final documentation formatting: **PASS**.

E03.1–E03.4 are verified at their specified U/B consumer level. No DB race,
authenticated real API/browser integration, SIP/WebRTC/FS/RTP, provider, hosted CI,
load, deployment or production acceptance is claimed by this result. Native
source/snapshot/executor bootstrap remains the explicit staged integration
boundary described above. No commit, push, PR or deployment was performed.
