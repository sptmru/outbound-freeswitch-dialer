# B05 — Call coordination API contract v1

Date: 2026-11-15. [B05 / #13](https://github.com/sptmru/outbound-freeswitch-dialer/issues/13),
under [tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Branch: `feat/b05-call-contracts`. Base: `a74c9ec`.

This is a contract and compatibility change. Native admission, offers, transfers,
Desk binding and administrator CRUD are implemented by C/D/E/F/G, not by B05.
No new runtime routes are mounted. The feature remains disabled. Local source
and tests do not establish browser media, provider delivery or target readiness.

## Selection and source contract

The checkout was clean. Live GitHub issues, B05's full body, comments/timeline
and all open PRs were checked twice. A01–A07 and B01–B04 were closed; B05 was
open, unassigned, without a start comment or open PR. Its dependency statement
and Dependency links require A01 and B01–B04, all satisfied. A02/A07's owner
amendments retain the later provider/enablement gates. The start comment names
this branch. Only B05 is being worked on.

Read AGENTS.md, requirements, implementation status, architecture, ADR 0001,
source-plan sections 4–6, 8–9, B01–B04 contracts and migrations 025–028. Searched
the Developer Knowledge Base for the backlog/task and exact `startReason`.

Shared types and transition tables are exported through
`packages/shared/src/index.ts` from `call-coordination.ts`. API validators and
pure fingerprint/replay helpers are in `apps/api/src/call-coordination-contracts.ts`.
The browser reexports the same built types from `apps/web/src/types.ts`.

## Live compatibility boundary

Existing paths remain `/agent/desk`, `/agent/events`, `/agent/call-next`,
`/agent/manual-dial/start`, `/agent/leads/:contactId/call` and current controls.
`AgentDeskResponse.coordination` is optional during rolling upgrades. Its absence
means the server does not advertise v1 coordination; it is not permission to
accept, infer a free slot, dismiss offers or enable automatic native work.
The existing first-party browser continues its legacy outbound contract.

The three existing start paths accept an optional nested `intent`. C04 implements
manual intent behind an internal execution dependency; the default `server.ts`
still returns **409 `coordination_unavailable`** before claims or ESL because that
dependency is not installed. When explicitly integrated, manual intent returns
`{status: "started", revision, callId, operationId}` for durable admission. It is
not conversation proof. [C05 automatic intent](inbound-auto-next.md) now uses this
same staged execution seam: it returns the original started identity or a durable
`deferred/incoming_pending` intent before any contact claim. Canceled/stale work
returns 409 and cannot be retried as manual automatically.
Malformed/partial intent and unrecognized actor/agent fields return 400 instead
of being stripped into an unintended legacy call.

Missing `intent` remains a legacy request, with no implicit manual privilege,
stable idempotency or permission to dismiss an offer. C04 serializes legacy starts
under the common global admission lock and campaign/user/agent locks. Creation
refuses unrevoked Desk sessions, pending offers, open automatic intents/transfers,
native participation or native reservations. Once the native reconciliation
marker is set, every missing-intent start fails closed, even without an offer or
controller. **409 `legacy_initiator_required`** preserves attempts, offers,
transfers, slots and calls. Existing feature-off outbound remains available while
reconciliation is required and no coordinated work exists.

The [C04 protocol and evidence](inbound-manual-outbound.md) include the C03 executor
bridge and full native token revalidation. Native writer activation still requires
all competing paths, session/endpoint lifecycle, protected pools and driver,
recovery and the I01–I05 gates. Do not remove the guard or silently drop `intent`.

C06 extends the two existing end/voicemail controls with the same optional Desk
mutation `intent`. Its native producer returns `CallControlResponse` with
`status: "accepted"`, revision, call and operation IDs. This acknowledges durable
work; only verified jobs/concrete events release resources. Missing native-control
execution dependency returns 409 before mutation. Legacy requests remain guarded.
See [C06 control and evidence](inbound-call-cleanup.md). Native control conflicts
also include `call_outcome_uncertain`, `transfer_in_progress` and
`voicemail_unavailable`; they never authorize fallback to a legacy command.

## Requests, revisions and endpoint binding

All IDs and idempotency keys are UUIDs. PostgreSQL revisions and generations are
positive canonical decimal **strings**, at most `9223372036854775807`; no leading
zero or conversion through JavaScript `number` is allowed.

A coordinated mutation carries `deskSessionId`, `expectedRevision`,
`bindingGeneration`, `idempotencyKey`. The authenticated user determines the actor;
no request-supplied agent, actor or SIP destination is authoritative. A mutation
with a session path parameter must match its body's `deskSessionId`. Recipients
and resource IDs require fresh server authorization under admission; a matching
UUID alone grants nothing. An administrator using Agent Desk acts through their
own agent identity, not arbitrary agents' resources.

For `/agent/call-next`, `intent` is one of:

```json
{
  "startReason": "automatic",
  "sourceCallId": "22222222-2222-4222-8222-222222222222",
  "deskSessionId": "11111111-1111-4111-8111-111111111111",
  "expectedRevision": "9007199254740993",
  "bindingGeneration": "2",
  "idempotencyKey": "33333333-3333-4333-8333-333333333333"
}
```

Manual intent uses the same fencing fields and `startReason: "manual"`, without
`sourceCallId`. Lead/manual-number endpoints only accept manual intent. Existing
campaign, phone and lead-confirmation fields remain at the root of their requests.
`startReason` describes intent, not authorization or SIP readiness. Automatic
clients retain the same source/key while deferred and must never retry as manual.
C05 validates qualifying outbound source completion, campaign/flag/readiness and
controller under admission; inbound completion or handover is not qualifying.

Session creation uses `CreateDeskSessionRequest`: `idempotencyKey`, nullable
`expectedRevision` and nullable `campaignId`. Null revision means no current
controller; takeover names the current revision. PATCH carries the mutation fields,
`campaignId`, and desired `ready`. Server verification alone establishes endpoint
readiness. DELETE carries the mutation fields. Occupied/uncertain slots forbid
ordinary takeover; heartbeat expiry cannot release them. D01 owns verification,
provisioning, generation-scoped cleanup and transactional revision advancement.

## Snapshots and mutation results

`coordination` contains `contractVersion: 1`, server `revision`, current `session`,
`slot`, `offer`, `transfer`, `autoNextIntent` and independent `actions`:
`manualStart`, `autoNext`, `accept`, `ignore`, `transfer`. Each action carries
`allowed` and nullable `reason`. A pending inbound offer owns no recipient slot.
For example, a free agent can have `manualStart.allowed: true` alongside
`autoNext: { allowed: false, reason: "incoming_pending" }` and a deferred intent.

Offers carry identity, kind, optional transfer identity, call/campaign, caller,
deadline, state and closure reason. Transfer snapshots preserve source/recipient
identities and a separate lifecycle. Slot snapshots retain reservation/generation
through uncertainty. UI hints do not replace server revalidation or timer deadlines.

Acceptance uses `AcceptCallOfferResponse`: **`status: "connecting"`**,
`revision`, `callId`, `operationId`, `offerId`. It reserves work; HTTP success and
ESL acknowledgement do not prove a bridge. Only correlated runtime evidence may
advance to `agent_connected`. Rejected/expired/stale offers require refetching Desk.

Other coordinated results distinguish `started`, `deferred` and `applied`.
Deferred work returns `reason: "incoming_pending"`, the same intent identity and
no new call/operation/contact claim. Ignore closes an inbound offer as `ignored`;
on transfer offers it means `declined`. Expiry stays `expired` and preserves the
persistent inbound exclusion. `winner_accepted` is cancellation, not exclusion.

`CoordinationErrorResponse` preserves `message`, adds a bounded `code`, and nullable
`revision` (null means no authoritative revision was read). Conflict codes include
`revision_conflict`, `idempotency_conflict`, `not_controller`, `slot_occupied`,
`offer_closed`, `offer_expired`, `not_owner`, `endpoint_unavailable`, and
`capacity_exhausted`. Refetch after conflict; do not reinterpret it as a telephony
failure or create a fresh automatic/manual request to bypass coordination.

## Idempotency and allowed transitions

Scope v1 is `v1:` plus SHA-256 of the JSON tuple
`[authenticatedUserId, uppercaseMethod, routeTemplate, resourceIdOrNull]`.
This fits B04's 200-character scope bound. Keys are UUIDs; POST/PATCH/DELETE and
different actors/resources do not share a scope. A valid retry retains the original
revision/source/key. After authenticating and checking resource access, look up
scope/key before rejecting the retry for an advanced current revision.

Fingerprint v1 hashes canonical JSON of `{version:1, method, route, resourceId,
payload}`. Use validated/normalized JSON; sort object keys lexically, preserve array
order, omit undefined members and `idempotencyKey` fields. Include campaign/target,
source, revisions/generation, confirmation flags and intent. Apply defaults before
hashing. Do not log payloads/fingerprints containing customer metadata as debug dumps.

Same scope/key and fingerprint returns the stored original terminal result, including an
already-ended started call; changed payload conflicts. A matching request for a
pending/executing/uncertain operation returns a pending decision, never permission
to send another command or an invented successful result. Authoritative persistence
and source-completion deduplication are C03/C04/C05/E/G work. The B05 pure helper
is a protocol oracle, not an in-memory replacement for PostgreSQL. Deferred intents
can be reevaluated under their original identity; once started, retry cannot dial
again. C05 cancels stale deferred intents on acceptance, explicit manual claim,
campaign/controller change and other invalidating transitions.

Exported offer/transfer/operation/automatic-intent/inbound-phase tables define
allowed state changes. Equal-state replay does not authorize rewriting stored
terminal evidence. All terminal states have no outgoing edge. Acceptance cannot
reopen an offer. Executing/uncertain operations cannot return to pending/executing;
resolution requires confirmed evidence. The `connecting -> queued` inbound edge
requires bounded retry and confirmed cleanup within the original queue deadline.
Fallback cannot return to acceptance. Phase `forwarding` matches migration 027;
external dialing/answer evidence remains in its operation/leg, not legacy `bridged`.
The tables never override database guards, fixed identities, deadlines or media proof.

## Planned operation catalog and admin configuration

`/docs/json` retains live paths and exposes **`x-planned-call-coordination`** with
`status: "contract-only"`, v1 and a separately validated OpenAPI `paths` catalog.
No unimplemented operation is added to the main live `paths`. It specifies:

| Operations                                                                          | Request / response                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| POST `/agent/call-offers/{offerId}/accept`                                          | DeskMutationRequest / AcceptCallOfferResponse                            |
| POST `/agent/call-offers/{offerId}/ignore`                                          | DeskMutationRequest / CoordinationMutationResponse                       |
| GET `/agent/calls/{callId}/transfer-targets`                                        | no body / TransferTargetsResponse                                        |
| POST `/agent/calls/{callId}/transfers`                                              | CreateTransferRequest / TransferSnapshot                                 |
| DELETE `/agent/calls/{callId}/transfers/{transferId}`                               | DeskMutationRequest / TransferSnapshot                                   |
| GET, POST `/admin/inbound-numbers`, `/admin/inbound-queues`, `/admin/inbound-flows` | list or SaveInbound*Request / typed list or snapshot                     |
| PATCH, DELETE each `/admin/inbound-*/{id}` collection above                         | SaveInbound*Request or InboundAdminMutation / snapshot or DeleteResponse |

Agent operations require an authenticated active user and resource ownership;
admin operations require `admin`. All unsafe cookie-authenticated operations retain
the existing allowed-Origin check; explicit Bearer clients retain existing behavior.
No plan catalog entry authorizes new runtime routes or bypasses those guards.

Admin mutation fields are `idempotencyKey` and `expectedRevision` (null for creation,
required current value for update/delete). Number routes include `label`, normalized
`did`, `queueId`, `enabled`. Queue configuration retains B01's distinct offer/queue/
connect/transfer budgets, waiting capacity, overflow policy/version and campaign-owned
waiting/no-answer media. Enablement belongs to number routes, not an independent
queue switch. Flow saves include `campaignId`, name and bounded definition; editing
creates a new immutable `versionId`. Delete must reject referenced/live versions,
not remove executing snapshots. Number/queue snapshots distinguish desired/applied
revision, pending/applied/error and bounded apply error; HTTP save is not applied FS
configuration. F01/F02 implement ownership, revision, reference and audio checks.

## Acceptance verification

| Criterion | Evidence                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B05.1     | `call-coordination-contracts.test.ts`: valid/invalid payloads, bigint boundaries, Desk manual/automatic action independence, transfer/slot/deferred fixtures. API/web compile; OpenAPI component/catalog coverage.                                                                                                                                                                                                   |
| B05.2     | Same suite: acceptance is connecting, exhaustive terminal regression checks, uncertainty edges, canonical fingerprints, actor/resource scope separation, original result replay and changed-payload conflict. Durable execution behavior remains C/E/G.                                                                                                                                                              |
| B05.3     | `call-coordination-api.test.ts`: Fastify auth, wrong admin role, forged actor/agent IDs, partial metadata, cookie CSRF and explicit unsupported intent, with read-only query ledger. `call-coordination-legacy.integration.test.ts`: all three legacy API routes with a pending offer and again with an isolated pre-SIP native reservation, unchanged before/after database snapshots and zero ESL TCP connections. |
| B05.4     | Shared build, OpenAPI generate/check, API/web typechecks, contract tests and full quality. `api-documentation.test.ts` validates live and planned catalogs separately and checks planned routes are absent from live paths.                                                                                                                                                                                          |

## Local verification result — 2026-11-15

B05.1–B05.4 passed at the required U/API level. Node.js v23.7.0 (required >=22).
Changes remain local and uncommitted on `feat/b05-call-contracts`.

| Command / environment                                                                         | Result and retained local evidence                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash /tmp/b05-quality-pg16.sh`                                                               | PASS. Runs `npm run quality` with explicit disposable PostgreSQL 16: OpenAPI, lint, formatting, API/web typechecks, 307 API tests (zero skipped), 135 web tests, 76 ops tests, shared/API/web builds. `/tmp/outbound-inbound-db.DH50dAVK/` retains the exact runner, pinned image/source hashes, result and cleanup record. |
| `bash scripts/test-inbound-db.sh` (`npm run test:inbound:db:isolated`)                        | PASS. Pinned PostgreSQL 17, 17/17 tests, zero skipped, including the six legacy API rejection checks. Final evidence: `/tmp/outbound-inbound-db.qCfRQdBW/`.                                                                                                                                                                 |
| `npm --workspace @outbound-dialer/shared run build`, API `openapi:generate` / `openapi:check` | PASS. Shared output rebuilt before consumers; 124 OpenAPI component schemas. Both live and planned catalogs pass OpenAPI validation.                                                                                                                                                                                        |
| `git diff --check`, `bash -n scripts/test-inbound-db.sh`, artifact `sha256sum -c`             | PASS. Final source hashes match both database runs.                                                                                                                                                                                                                                                                         |

Both disposable database containers and schemas were removed. Earlier fixture
failures and code revisions are superseded by these final passing runs.

These checks use real PostgreSQL and Fastify with synthetic calls and a local
ESL connection-counting listener, plus web unit/component tests. No real
FreeSWITCH/SIP/RTP, browser media journey, provider, target deployment/load,
hosted CI, product enablement or production acceptance was performed. Their
later gates remain mandatory. The separate voicemail DB runner was not needed
for this contract-only change and was not executed. No commit, push, PR or
deployment was performed.

## D01 implementation update

POST `/agent/desk-sessions` and PATCH/DELETE `/agent/desk-sessions/{sessionId}`
are now mounted authenticated handlers and appear in live OpenAPI paths, rather
than the planned catalog. Create can return optional owning-controller `sip`
credentials, WSS URL and ICE configuration. Mutation results persist no credentials.
See [D01 lifecycle, replay, verification and activation boundaries](inbound-desk-sessions.md).
The normal Desk response/native executor bootstrap remains staged under I05;
this update does not enable inbound calling.
