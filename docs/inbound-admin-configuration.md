# F01 — Inbound administration API

Task: [F01 #29](https://github.com/sptmru/outbound-freeswitch-dialer/issues/29).
Base: `62413ee98622798450fa55972c6c2fe278de91b0`; local branch
`feat/f01-inbound-configuration`.

F01 mounts the B05 configuration contracts. It saves administrative configuration;
playback/forwarding execution remains F03/F04, [audio storage/preview](inbound-audio-library.md) is supplied by F02,
and the [F05 administrator UI](inbound-admin-ui.md) consumes these contracts. Provider acceptance and activation remain
I04/I05. Saving or enabling a DID does not establish provider ownership or delivery.
`FREESWITCH_INBOUND_CONFIG_ENABLED=false` remains the default; no new environment
variables, host ports or deployment path are introduced.

## HTTP contract

All endpoints require an active administrator. Bearer authentication and the existing
HttpOnly cookie are supported. Cookie mutations require an allowed `Origin`.
Responses use `Cache-Control: no-store`. Agent payloads cannot choose forwarding
targets or bypass campaign ownership through these routes.

| Collection               | GET                                    | POST                                   | PATCH `/:id`                             | DELETE `/:id`                                        |
| ------------------------ | -------------------------------------- | -------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `/admin/inbound-numbers` | `{ items: InboundNumberSnapshot[] }`   | `SaveInboundNumberRequest` → snapshot  | Full replacement → snapshot              | `InboundAdminMutation` → `{ ok: true }`              |
| `/admin/inbound-queues`  | `{ items: InboundQueueSnapshot[] }`    | `SaveInboundQueueRequest` → snapshot   | Full replacement → snapshot              | `InboundAdminMutation` → `{ ok: true }`              |
| `/admin/inbound-flows`   | Latest version of each nondeleted flow | `SaveInboundFlowRequest` → new version | Full replacement → new immutable version | Tombstone identity; retain versions → `{ ok: true }` |

The schemas and examples are discoverable through the existing administrator OpenAPI
catalog. These 12 operations are live handlers, removed from the contract-only catalog.
Successful creates, replacements and deletes return HTTP 200.

Every mutation body contains a UUID `idempotencyKey` and `expectedRevision`: `null`
on POST, the latest canonical decimal string on PATCH/DELETE. Reuse the same key
and same normalized payload after a lost response. A changed method, resource, ID,
revision or payload with that key returns `409 idempotency_conflict`. Keys are scoped
to the administrator, shared across all three collections. Authorization is rechecked
before replay. A replay returns the **original** response, including its historical
application status; GET the collection to learn current applied/error state.

PATCH replaces the full document, not individual supplied fields. Unknown fields
are rejected rather than stripped. Queue `configuration` uses the existing A06
defaults when fields are omitted, so clients should submit all intended settings.

- Number: `label`, `did`, `queueId`, `enabled`. Several DIDs can share a queue.
  `enabled` is explicit, including on create. At most 200 saved numbers match D02's
  renderer bound. International DID/target input is normalized before strict
  `libphonenumber-js` validation: `0014155550100` and `+1 (415) 555-0100` save as
  `+14155550100`. These contracts require international input; they do not guess a
  country or accept SIP URIs or arbitrary dial strings.
- Queue: `name`, immutable `campaignId`, nullable `waitingRecordingId` and
  `noAnswerFlowVersionId`, plus `configuration`: `offerTimeoutMs`, `queueTimeoutMs`,
  `connectTimeoutMs`, `transferTimeoutMs`, `maxWaitingCalls`, `overflowPolicy` and
  nullable `overflowFlowVersionId`. See [bounds](inbound-routing-schema.md).
  `overflowPolicy=flow` requires the version; `reject` forbids it. Audio and flow
  references must be active and owned by that campaign. A queue may intentionally
  use an older enabled immutable flow version.
- Flow: immutable `campaignId`, `name`, optional `enabled` (defaults to true), and
  `definition: { flowTimeoutMs, actions }`. Every PATCH, including rename/disable,
  appends a version. `revision` is that version number and `versionId` is its UUID.
  Merely saving v2 does not move queues from v1; update their explicit version IDs.

A missing row returns 404; stale/missing update revision returns
`409 revision_conflict`. Reference errors return `queue_unavailable`,
`flow_unavailable`, `audio_unavailable` or `campaign_unavailable`. A campaign cannot
be reassigned on queue/flow PATCH (`campaign_immutable`). Duplicate normalized DIDs
return `duplicate_configuration`. A busy publisher/transaction returns
`configuration_busy`; retry the same key. Rejections do not change configuration,
versions, replay receipts, calls, offers, participants, attempts, slots or capacity.
Normal admin audit events also record rejected attempts with their HTTP status.

## Finite flows and reference lifecycle

Reuse the B01 linear definition: 1–3 actions, at most two `play_audio` and one
`forward_external`; no jumps, nested flows, graph edges or retry counters. Playback
has `recordingId` and `timeoutMs` (1–60 seconds); forwarding has the saved normalized
`target` and `timeoutMs` (5–30 seconds). Optional `hangup` must be last. The sum of
bounds fits `flowTimeoutMs` (1–180 seconds, default 90 seconds). The saved asset's
full duration must fit its playback bound. Unknown/inactive/foreign audio is rejected.

```json
{
  "flowTimeoutMs": 90000,
  "actions": [
    { "type": "play_audio", "recordingId": "11111111-1111-4111-8111-111111111111", "timeoutMs": 10000 },
    { "type": "forward_external", "target": "+14155550199", "timeoutMs": 20000 },
    { "type": "play_audio", "recordingId": "11111111-1111-4111-8111-111111111111", "timeoutMs": 10000 }
  ]
}
```

On forward success the bridged call owns completion; on busy/no-answer/failure the
next action is the failure continuation. Exhaustion means hangup. Audio-only and
forward-only flows also terminate on exhaustion. There is no recursive overflow
or unreserved forward retry. F03/F04 must implement these semantics and collect
actual playback, external-leg, cleanup and provider evidence.

Forwarding to any saved DID, including disabled numbers, returns
`owned_did_forwarding_loop`. The reverse edit order is checked too: adding/changing
a DID cannot collide with any saved forwarding target. This deliberately includes
historical versions so an old executing snapshot cannot acquire a new loop. It is
conservative: a retained historical target prevents adding that DID even after
flow deletion. Retention/reclamation belongs to H04; there is no unsafe override.

Disable a number with PATCH `enabled=false` to stop new routing after D02 applies
it. Disabling remains possible after campaign archive. DELETE requires the number
already be disabled (`disable_before_delete`). Queues are deleted only when no
number or retained call references them; otherwise `configuration_in_use`. There
is no separate queue enabled flag: disable its numbers. Lowering queue capacity
changes future admissions and does not evict admitted calls.

A flow referenced by a queue's no-answer or overflow configuration cannot be disabled
or deleted (`configuration_in_use`), even when its numbers are disabled. Reassign or
clear queue references first. Unreferenced flow deletion hides/disables the identity
without deleting any version. Old executing snapshots retain their original version,
audio metadata, deadlines and targets. Historical versions conservatively pin audio
through the existing recording deletion guard. Queue audio replacement affects future
snapshots; it does not rewrite captured ingress or admitted calls.

## Serialization, audit and application evidence

Migration `040_inbound_admin_configuration.sql` adds flow `enabled`/`deleted_at`
and `inbound_configuration_mutations`; it does not edit applied migrations, seed
routes, enable routing, change old versions or modify outbound voicemail assignments.
Existing flow identities default to enabled for configuration compatibility; this is
not route enablement. New API handlers require migration 040 before serving requests.

All API writers acquire configuration advisory lock `(72204, 0)` **before** any
explicit user/campaign/audio/configuration row lock. This is the same lock used by
D02's publisher and BEFORE STATEMENT number/queue triggers. After waiting, the writer
rechecks administrator role/auth version, replay, revision and references under READ
COMMITTED. Media is locked FOR SHARE, which also blocks concurrent soft deletion.
No call-admission/media lock is acquired and no ESL, filesystem or provider operation
runs inside this transaction. Direct administrative SQL edits are outside these API
guarantees and must obey D02's lock ordering.

`inbound_configuration_mutations` commits the actor/key, canonical fingerprint,
method/resource/ID, resulting revision, request ID and original response **with** the
configuration. It is both a replay receipt and a durable version-linked audit trail;
rollback removes both. Existing `admin_audit_events` additionally retains each HTTP
attempt with actor, route, request ID, status and source metadata. No credentials or
raw request body are copied to either audit. Retain receipts and version references
until an explicit H04 replay/retention policy is implemented.

Number/queue snapshots expose `apply.desiredRevision`, `appliedRevision`, `status`
(`pending`, `applied`, `error`) and nullable `error`. An unverified bundle remains
pending even if one entity's revision matches. Current bundle application errors
are propagated to entity snapshots. Only the existing D02 publisher can establish
applied state, by atomic file publication, reload and effective-context verification;
saves never send ESL. Failed application retains the old applied revision and
last-good routing. Flow versions have no standalone applied flag: assignment and
its queue/DID bundle establish the application boundary.

## Verification and boundaries

With Node 22:

```bash
PATH=/tmp/node-v22.13.0-linux-x64/bin:$PATH INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated
npm run quality
git diff --check
```

`inbound-configuration.test.ts` covers normalization/finite flow tables.
`inbound-admin.integration.test.ts` covers HTTP CRUD/security, every reference class,
immutable versions/captured active ingress, desired/applied/error snapshots, atomic
receipts/audit and populated upgrade/replay. Separate PostgreSQL connections and
`pg_blocking_pids` establish both edit orders, rollback, simultaneous replay,
post-wait access revocation and both DID/forward-flow creation orders. Reports and
source hashes are retained by the isolated inbound DB runner; its publisher test
uses a **simulated FreeSWITCH command transport** with actual local file publication.
It establishes no new SIP/media/provider proof. The runtime publisher implementation
is unchanged; D02's independent real-FS evidence remains in its own issue.

Actual run commands, results, artifact locations and remaining gates are recorded
in issue #29. F01 U/DB/API checks do not establish F02 storage/preview, F03 playback,
F04 forwarding, F05 UI, browser WebRTC, far-end/provider behavior, load/soak, hosted
CI, target deployment/rollback or production acceptance.
