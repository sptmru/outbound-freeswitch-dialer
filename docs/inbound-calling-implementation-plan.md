# Inbound Calling and Agent Transfer Implementation Plan

Date: 2026-11-14. Repository: `outbound-dialer`.

Source review baseline: commit `91c7a8c257e7a73d83478ffd085152cc777993cf`.

**Status: implementation and handoff plan. The functionality is not implemented.**
The user authorized this document and its revisions, but has not authorized application
code changes, migrations, environment changes, or deployment. A subsequent agent
needs an explicit implementation task before starting a phase.

This revision incorporates the user's corrections: English language; no mandatory
Accept/Ignore step before manual outbound solely because an inbound offer exists;
explicit unit, integration, end-to-end, and load testing for new functionality.
The user also accepted the review on 2026-11-14: no automatic reoffer after inbound
offer expiry; atomic transfer-offer decline on successful manual outbound; and explicit
contracts for ingress recovery, Desk-to-SIP binding, overload, and executor DB capacity.
Approval applies to this plan; implementation and runtime acceptance remain pending.

Owner-approved amendment, 2026-11-14: A02's isolated local FS/R prototype is complete
and merged into `dev` by [PR #49](https://github.com/sptmru/outbound-freeswitch-dialer/pull/49).
Actual-provider checks originally included in A02 are deferred to
[I04 #46](https://github.com/sptmru/outbound-freeswitch-dialer/issues/46), without waiver.
Dependencies on A02 consume its local contract; isolated development may proceed.
Real inbound routing remains disabled until I04 and I05 acceptance and explicit
deployment authorization. This amendment changes backlog scope, not runtime behavior.

## 1. Confirmed Requirements

- Start with one inbound number and one shared queue; support adding numbers later.
- Keep the existing SIP provider. Inbound routing with that provider is not verified.
- The same agents handle inbound and outbound; initial scale is about 20 agents.
- Associate the queue with a campaign. Recipients have that campaign **currently
  selected in Agent Desk**, rather than a separate administrator-assigned membership.
- Offer the call to all eligible agents simultaneously. Exclude agents with active
  calls. Acceptance must be manual.
- An agent can accept or ignore an offer.
- If an inbound offer expires without acceptance, record `expired`, not `ignored`,
  and do not automatically offer that call to the same agent again. This exclusion
  survives Desk-session changes and requeue attempts for that customer call.
- Support simple agent-to-agent transfers without consultation, for both inbound
  and outbound calls.
- Administrators configure no-answer handling: prerecorded audio, forwarding to an
  external number, or a combination of those actions.
- VM means **playing prerecorded audio**, not recording a caller's message. A voicemail
  inbox and caller-message capture are outside this request.
- Receive calls only in Agent Desk.
- Administrators manage numbers, queues, audio, and flows through the UI.
- Do not require an agent to accept or explicitly ignore an inbound offer before
  manual outbound without separately agreeing that restriction. The proposed mechanism
  is atomic dismissal of only that agent's inbound offer when manual outbound succeeds.
- A pending transfer offer likewise does not require a separate decline before manual
  outbound. Successful admission atomically declines that recipient's pending transfer
  and leaves the original conversation with the source agent. Failed admission does
  not decline it; an already accepted transfer reservation cannot be displaced.

## 2. Confirmed Policies and Proposed Behavior Defaults

The expiry/no-reoffer and manual-outbound policies in section 1 are confirmed
requirements. Other entries below are proposed defaults and can be revised without
weakening those requirements or the concurrency invariants in section 5.

| Situation                                                             | Behavior (confirmed policies identified above)                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Agent paused, outside Desk, phone not ready, or slot occupied         | Do not create a new offer                                                                             |
| Multiple waiting calls                                                | FIFO by arrival time, stable tie-breaker by call ID                                                   |
| One agent, multiple waiting calls                                     | At most one open offer; oldest eligible call first                                                    |
| Agent ignores                                                         | Close only their offer; preserve the customer call and other offers                                   |
| Agent already ignored this call                                       | Do not automatically offer the same call to them again                                                |
| Inbound offer expires without acceptance                              | Close as `expired`; do not automatically reoffer this call to that agent                              |
| Matching agent becomes free                                           | Offer eligible waiting work                                                                           |
| All agents busy or excluded by ignore/expiry                          | Wait until the overall queue deadline, then run the no-answer flow                                    |
| Queue deadline expires                                                | Atomically close acceptance and begin fallback                                                        |
| Inbound offer or eligible queued inbound exists; auto next is pending | Defer automatic advancement                                                                           |
| Agent explicitly starts manual outbound with an inbound offer         | No extra Ignore click; dismiss their offer and claim outbound in one successful admission transaction |
| Manual outbound validation/admission fails                            | Roll back dismissal; do not close the offer because of the failed start                               |
| Manual outbound races with the same agent's inbound acceptance        | First successful slot claim wins; never two calls                                                     |
| Transfer offer pending                                                | Keep the original conversation connected                                                              |
| Recipient starts manual outbound with a pending transfer offer        | Atomically decline that transfer with successful outbound admission; preserve the source conversation |
| Recipient declines or times out                                       | Preserve the original conversation                                                                    |
| Selecting transfer recipient                                          | Any eligible free agent in Desk, including another selected campaign                                  |
| Transfer completes                                                    | Preserve call campaign; update current participant                                                    |
| Inbound ends or an agent hands over a call                            | `activeCall -> null` alone must not trigger auto next                                                 |

Configure offer, queue, connection, and transfer deadlines separately. Select actual
values through UX and call-path validation. Failed connection attempts do not restart
the customer's overall queue deadline.

## 3. Existing Implementation and Required Changes

Recheck the actual checkout and `AGENTS.md` before implementing:

- [Requirements](requirements.md), [architecture](architecture.md),
  [implementation status](implementation-plan.md), [ADRs](adr/).
- [Outbound creation](../apps/api/src/dashboard/calls.ts): `createDialerCall` checks
  `ops.call_start_paused`, locks the agent, checks active calls, and reserves contacts.
- [Agent Desk](../apps/web/src/features/agent-desk/agent-desk.tsx): a React effect starts
  auto next when `activeCall` disappears, subject to manual-call, campaign, pause, and
  phone-readiness checks, through ordinary `POST /agent/call-next`.
- [Contracts](../packages/shared/src/index.ts): `StartNextCallRequest` currently does
  not distinguish manual next-lead requests from automatic advancement.
- [Media locks](../apps/api/src/user-media-lock.ts): existing advisory locks coordinate
  Desk and supervisor operations. New paths must preserve that exclusion.
- [Finalization](../apps/api/src/call-finalization.ts) and
  [agent release](../apps/api/src/agent-availability.ts) assume one current owner;
  current lock order is agent before call.
- The [public dialplan](../infra/freeswitch/templates/dialplan/public/reject.xml.tpl)
  rejects inbound. New ingress requires trusted-source and DID validation.
- The [softphone](../apps/web/src/softphone.ts) automatically answers service INVITEs
  for outbound. This must not automatically accept inbound offers.
- [ESL handling](../apps/api/src/esl-events.ts) expects product call correlation and
  contains outbound-specific transitions. Initial inbound needs its own ingestion path.
- `reconcileActiveCalls` starts from persisted `calls`; it cannot discover an inbound
  channel whose first database insert never happened. Section 6.1 covers this boundary.
- [Originate](../apps/api/src/esl.ts) sets `hangup_after_bridge=true`. Customer-leg
  preservation during rebridging needs an early prototype.
- Current originate addresses `user/<sipUsername>@<domain>`, not a specific Desk
  session. A session check on receipt does not establish correct SIP delivery; section
  9.1 requires a verified session-to-endpoint binding.
- The [database pool](../apps/api/src/db.ts) currently has `max: 10` and
  `connectionTimeoutMillis: 5_000`. Executors must not consume all control-plane capacity.
- FreeSWITCH statistics use `(call_id, leg_type)`; browser statistics use `call_id`
  and authorize through `calls.agent_id`. Transfers need per-leg/participant handling.

These are source observations, not proof of current production behavior.

## 4. Architecture and Data Model

API/PostgreSQL own queues, offers, reservations, and durable transitions. FreeSWITCH
owns SIP/RTP, waiting audio, playback, and bridging. The browser displays server-owned
offers and starts connecting only after explicit agent action.

Propose an application dispatcher rather than an independent agent scheduler in
`mod_callcenter`: one arbiter must resolve inbound, outbound, auto next, and transfers.
At approximately 20 agents, prioritize simple verifiable coordination over maximum
admission parallelism. Names below are proposals; choose migration numbers at implementation.

| Entity                     | Data and constraints                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `inbound_numbers`          | Normalized unique DID, label, queue, enabled, route revision                                        |
| `inbound_queues`           | Campaign, waiting audio, deadlines, queue limit, overload policy, no-answer flow; shared by DIDs    |
| `inbound_flows` / versions | Bounded action sequence, audio references, configured external targets                              |
| `agent_desk_sessions`      | Agent, campaign, session/revision, expiry, verified SIP endpoint/binding generation; one controller |
| `agent_call_slots`         | One persistent row per agent: call/participant, reservation ID, generation, state                   |
| `call_offers`              | Call, kind, agent, attempt, Desk/binding revision, deadline, state/reason; one open offer per agent |
| `call_participants`        | Call, agent/external party, concrete leg, role, participation interval                              |
| `call_transfers`           | Call, initiator, recipient, state, operation ID, deadlines; one unfinished transfer per call        |
| `call_operations`          | Idempotency key, request fingerprint, command kind, generation, fixed UUIDs, execution state        |
| `agent_auto_next_intents`  | Source completion, campaign, Desk revision, pending/deferred/started/canceled, stable retry key     |
| Capacity reservations      | Resource scope/type, call/operation/leg, generation, state; atomic claims and confirmed release     |

B02's feature-off schema and internal fenced slot primitives are documented in
[Desk slots and capacity](inbound-desk-slots-capacity.md). Migration 026 captures
legacy ownership/resources conservatively and leaves reconciliation required.
C01–C07/D01 still own runtime integration; this schema does not establish actual
media absence, enforce aggregate capacity or enable inbound.

B03 supplies the additive call origin/participation/concrete-media foundation in
migration 027, with an internal reader and explicit legacy-reader exclusions.
See [the B03 schema, evidence semantics and compatibility matrix](inbound-call-participation.md).
Product lifecycle writers/public contracts/history integration remain later tasks.

B04 adds durable offers and exclusions, transfers, operation identities/results,
auto-next source intents and independent ingress evidence/checkpoints in migration 028. See [the B04 storage, retention and verification contract](inbound-durable-call-work.md).
This is feature-off storage; admission/execution, journal integration, retention
and public API work remain their respective later tasks.

Extend `calls` with direction, original DID, calling/called numbers, queue, and current
owner. Inbound can exist without an agent or contact. Keep `calls.agent_id` as a
compatibility projection, not the sole occupancy record: transfers occupy the source
and reserve the recipient. Relate legs/statistics to concrete participations; migrate
history without loss and provide compatible read models where practical.

Record PSTN answer separately from `agent_connected_at`, queue deadline, participation,
and fallback timestamps. FreeSWITCH answering to play audio is not agent acceptance.
Inbound does not increment outbound `attempt_count` or automatically change contact
status. Matching contacts provide context. Fix campaign at ingestion, including transfers.
Retain per-call/per-agent ignore and expiry exclusions across distribution attempts.
Represent ingress evidence independently of an already existing `calls` row (section
6.1); creating only a foreign-keyed child row cannot close the pre-insert recovery gap.

B01 now supplies the additive routing/configuration schema and internal validation.
See [the B01 schema contract and verification](inbound-routing-schema.md). Runtime
inbound routing and call-side schema extensions remain separate tasks.

## 5. Race Prevention: Mandatory Invariants

1. At most one interactive slot per agent, including reservations before SIP creation.
2. At most one winning acceptance per inbound distribution attempt.
3. Ring-all offers do not occupy every recipient's slot; only the winner claims a slot.
4. Automatic outbound cannot bypass eligible durably queued inbound. Explicit manual
   outbound uses the separate atomic-dismissal policy in section 5.6.
5. Fallback/terminal prevents all stale offer acceptance.
6. Repeated HTTP/ESL does not create duplicate calls, participants, bridges, or external dials.
7. Old call release cannot free a newer reservation.
8. HTTP loss, lease expiry, and ESL timeout do not prove absence of created legs.
9. A previous agent's leg ending after transfer does not end the customer leg or call.
10. React guards, SSE, and process-local mutexes are not correctness mechanisms.
11. Manual outbound dismisses only that agent's pending inbound offer in the same
    committed transaction as outbound admission. It cannot cancel the customer call,
    other agents' offers, or an accepted reservation.
12. An expired inbound offer excludes that call from future automatic offers and
    inbound-priority checks for that agent, without changing other agents' eligibility.
13. Manual outbound atomically declines the recipient's pending transfer offer and
    transfer request; it does not end, release, or reassign the source conversation.
14. New queue entries and media legs obey atomic capacity reservations. Unknown command
    outcomes retain capacity until reconciliation establishes whether a leg can exist.

### 5.1. One PostgreSQL Admission Arbiter

For this single-tenant initial scale, propose one transaction-scoped advisory lock,
conceptually `pg_advisory_xact_lock(namespace, tenant_key)`. Select the namespace after
inspecting existing advisory locks.

All short transactions affecting assignment/release eligibility or inbound visibility
must use the gate: inbound enqueue/fallback/terminal; offer creation, acceptance,
ignore, expiry, and manual dismissal/transfer decline; every outbound path;
transfer reservation/completion; capacity claim/release;
slot release including voicemail release; campaign/pause/Desk-session changes; and
reconciliation/supervisor changes affecting media endpoint occupancy.

Read authoritative state **after acquiring the gate**, not from an earlier Desk
snapshot. Initially use `READ COMMITTED`; do not rely on snapshots established before
waiting for the lock. Use database time for deadlines and expiry.

Automatic outbound must inspect the queue itself, not only `call_offers`: inbound
can commit before offers are created. Eligible queued work already defers auto next,
except calls the agent previously ignored or whose offer expired for that agent.
Admission may create an offer synchronously before returning deferred.

Explicit manual outbound still takes the gate and checks occupancy, but queued
inbound alone is not a veto. Dismiss the current inbound offer atomically with a
successful manual start. Do not mark unseen queued calls ignored or close other
agents' offers. Occupied outbound slots are excluded from future offers.

The gate coordinates separate processes; state survives restarts. Never hold it
across ESL, file processing, network, or user interaction. Telemetry and ordinary
reads do not take it. Measure transaction duration/contention under load before
considering campaign-level sharding and revising the lock graph.

C01 now supplies the internal [ordered SQL admission and fenced slot protocol](inbound-admission.md),
including PostgreSQL race/revalidation checks. Legacy writers are not migrated or
enabled by this module; C02–C07 and the later runtime/cutover gates remain required.
C02 adds internal [shared capacity bundles, queue return permits and confirmed release](inbound-call-capacity.md)
under that gate; actual path migration, FS hard safeguards and enablement remain
with their owning tasks.

C07 supplies the [eligibility/supervisor protocol and completed writer inventory](inbound-eligibility.md).
Controlled PostgreSQL schedules verify eligibility, endpoint exclusion, capacity
and mixed locks. An isolated product-schema FreeSWITCH lab verifies supervisor
replacement and RTP directions. Native adapters remain staged; D01 owns controller/
binding lifecycle and I05 owns bootstrap, drain and production enablement.

### 5.2. Agent Slot and Fencing

One `agent_call_slots` row per agent changes from `free` to `reserved` with a new
`reservation_id` and incremented `generation`, then `connecting`, `active`, `releasing`,
`uncertain`, and finally `free`.

Update/release requires matching `(agent_id, call_id, reservation_id, generation)`.
Delayed old events are occupancy no-ops but remain in history. `free` requires
confirmed cleanup and resolution of commands that could still create the old leg,
not merely an expired timestamp.

Slot primary keys and offer/operation uniqueness reinforce the gate. Retain
`calls_one_active_per_agent_idx` as a secondary guard; it cannot alone protect a
transfer recipient who is not yet `calls.agent_id`.

### 5.3. Lock Ordering and Command Execution

The [A01 lock inventory and compatibility review](inbound-locks-and-compatibility.md)
records the current lock owners/lifetimes, migration checklist, controlled conflict
schedules and rollback-reader boundaries at `2c4050a`. Its target order is a source
review contract for later implementation, not a passing concurrency/runtime gate.

Inventory `lockUserMediaAction`, `lockUserMediaSession`, `lockCampaignVoicemail`,
maintenance, finalization, supervisor, and reconciliation locks before implementation.
Proposed common order:

1. Where required, per-call execution locks outside transactions, sorted by call ID.
2. `BEGIN`; new starts take the existing maintenance gate in its compatible mode.
3. Common admission advisory lock.
4. Required campaign audio locks, then user-media locks, in stable ID order.
5. Agent rows, then slot rows, sorted by agent ID.
6. Calls, transfers, offers/operations in stable ID order.
7. Capacity records in stable resource order, then contacts for outbound; persist claims
   and command intent.
8. `COMMIT`; execute ESL only afterward.

Skip unnecessary groups, never reverse the order. Do not acquire execution locks
while holding admission. If owners/participants changed, roll back and retry with
the correct set instead of taking earlier lock groups after later ones.

Migrate existing paths that take call/agent locks before the new gate before enabling
inbound. Inspect session-level media locks specifically for inversions.

A durable executor serializes each call's side effects. A dedicated PostgreSQL
connection holds the per-call execution lock through validation, ESL, and result
persistence, but **no transaction stays open during ESL**. Replacement, reconciliation,
and release follow the same protocol. Worker TTL is not execution serialization.

C03 supplies the internal [durable executor, protected pools and failure protocol](inbound-command-execution.md).
Its isolated DB/FS checks do not migrate legacy producers or enable routing;
C04–C07, D–H and acceptance gates retain their integration/media/deployment work.

On lost lock connection or ambiguous outcome, stop new actions and retain `uncertain`.
PostgreSQL fencing tokens do not automatically fence FreeSWITCH. The prototype must
establish how old workers stop and in-flight commands resolve before reuse. A momentary
`uuid_exists=false` is insufficient if an old command can still be sent/executed.

#### 5.3.1. Executor Connection Budget

The [A06 resource and acceptance budget specification](inbound-resource-budgets.md)
selects finite defaults, counting/overload rules, dedicated role/pool partitions and
replica-wide DB headroom. Its isolated PostgreSQL saturation prototype measures
protected SQL paths with simulated ESL; product C02/C03/D02 enforcement and
I03/I04/I05 media/load/provider/enablement gates remain separate.

Bound concurrent executors and their pending work. A connection is leased for one
serialized command sequence, not for the entire customer conversation or while an
offer waits for a human. Bound lock waiters as well as running executors; do not
allocate a connection to every queued operation.

Before phase C, choose a dedicated bounded executor pool or enforced connection
reservations that leave guaranteed capacity for API admission, Desk heartbeats, ESL
event persistence, and reconciliation. The current ten-connection shared pool is not
an implicit twenty-agent execution budget. Account for all workers/API replicas and
the database connection limit; merely increasing `max` is not the safety mechanism.

Specify executor concurrency, pool sizes/reserves, acquisition and command deadlines,
and bounded backlog behavior in configuration/runbooks. Command-lock holders must not
depend on acquiring another connection from an exhausted pool to persist/release work.
On overload, defer or reject unstarted work explicitly; ambiguous sent commands retain
their reservations under section 5.3. Measure pool waiters, acquisition failures, and
execution backlog. Slow/unresponsive ESL tests must prove heartbeats, event writes,
hangup handling, and recovery still progress within agreed budgets.

### 5.4. Auto Next Versus Inbound: Exact Outcomes

Guarantee one assignment per agent. Inbound priority over **automatic** outbound applies
after durable registration. An INVITE not yet registered by ingestion cannot retroactively
cancel committed outbound admission.

**Inbound wins admission first:**

1. Ingestion saves `queued` and overall deadline under the gate, then commits.
2. Auto next takes the gate and checks occupancy and the eligible queue.
3. It sees inbound even without `call_offers` rows.
4. Return `incoming_pending` / deferred: no lead selection, attempt increment, outbound
   call, or originate.
5. The agent may accept, ignore, or explicitly start manual outbound under section 5.6.

**Auto next wins admission first:**

1. Queue/readiness checks pass under the gate; save slot, call/contact claims, and intent.
   After commit the slot is occupied even before SIP creation.
2. Later inbound excludes that agent and offers to others.
3. Do not cancel the outbound automatically; queue inbound if nobody else is free.

**Concurrent arrival:** the gate establishes one order. The waiting path revalidates.
No path checks `free`, leaves its transaction, and originates without a committed claim.

### 5.5. Auto Next as an Idempotent Intent

The React effect initiates UX, not permission to dial. Extend `/agent/call-next` to
identify manual/automatic starts and carry source work/call ID, Desk revision, and
stable idempotency key. Missing legacy fields must not silently grant permission to
dismiss inbound offers; define a conservative compatibility response for ambiguous
requests while upgrading the browser contract.

Validate source outbound campaign-lead completion, current campaign, enabled flag,
readiness, pause, and controlling session. Inspect and preserve existing auto-next
behavior after confirmed outbound voicemail agent release through regression tests.
Inbound completion and handover do not qualify merely because `activeCall` disappeared.

- Two tabs/repeated HTTP for one source resolve to one operation/call.
- `incoming_pending` keeps the intent deferred without contact reservation.
- After ignore/expiry/offer closure, reevaluate **the same** intent against fresh state;
  the next eligible queued inbound still takes priority over auto next.
- Inbound/transfer acceptance, explicit manual outbound claim, campaign change, or
  controlling session change cancels the old deferred auto-next intent.
- Once outbound exists, retries return its ID/state even if already ended; the same
  key never creates another call.
- `startReason` describes intent, not privilege or authorization. Automatic code must
  never retry deferred work as manual to bypass inbound priority.

Invalidate stale callbacks/timers by server revision. Avoid outbound ringback for
deferred requests and handle expected conflicts as coordination, not telephony faults.
These are UI improvements in addition to server guarantees.

### 5.6. Explicit Manual Outbound With an Inbound or Transfer Offer

Manual includes an explicit click to call a lead, dial a number, or call the next lead.
Auto next remains a different initiator despite sharing `/agent/call-next`. Do not
require an extra Accept/Ignore/decline click solely because an inbound or transfer
offer exists. This permission applies only to pending offers, not accepted reservations.

Suggested successful transaction:

1. Validate actor, idempotency fingerprint, manual initiator, current Desk session,
   campaign, maintenance, phone readiness, pause, and occupancy under common locks.
2. Validate/reserve the requested contact/number with existing campaign, normalization,
   suppression, retry, and contact ownership rules.
3. Close only this agent's still-pending inbound offer as `ignored`, with a reason
   such as `manual_outbound_started`. If another agent already accepted the customer
   call and closed this offer, no dismissal is needed. For a pending transfer offer,
   instead close the offer and its transfer request as `declined` with that reason;
   preserve the source owner, slot, participation, and bridge.
4. Claim the outbound slot, save call/command intent, and cancel the old deferred
   auto-next intent in the same transaction.
5. Commit together, then originate. Do not issue a separate Ignore request followed
   by an unprotected outbound request.

All mutations follow section 5.3; the list above groups conceptual checks, not a new
lock order. A pre-commit failure rolls back offer dismissal, contact claim, and slot
claim. The offer may independently expire/close, but failed outbound must not be its
closure reason.

If this agent's inbound or transfer acceptance claims the slot first, outbound loses
with an occupancy conflict and cannot dismiss an accepted offer. If manual outbound wins,
stale acceptance loses; an inbound customer stays with the remaining agents or queued,
while a transfer customer stays in the source conversation.
Another agent accepting the customer call does not prevent outbound on this free
agent's endpoint. Preserve that other agent's reservation and call.

After successful commit, later originate failure does not restore an obsolete ignored
inbound offer or declined transfer. Reevaluate fresh state. Do not decline all queued
calls or reset customer deadlines. The manual exception changes priority, not occupancy limits.

Transfer decline is an atomic database transition, not an instruction to hang up the
source call or implicitly accept a transfer. Revalidate the source call/transfer under
the common lock order. If it already closed, do not overwrite its outcome or prevent
otherwise valid outbound admission. No ESL side effect is needed to decline an offer
that has not reserved or created a recipient leg.

### 5.7. Other Competing Transitions

| Race                                                       | Resolution                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Two agents accept inbound                                  | Gate, phase check, atomic claim; one winner                                  |
| One agent accepts two calls                                | Slot primary key/generation; one endpoint claim                              |
| Acceptance versus deadline                                 | One `queued -> connecting` or `queued -> fallback` transition, using DB time |
| Customer hangs up during acceptance                        | Live-path/terminal handling cancels connection; cleanup before release       |
| Pause/campaign change versus stale offer                   | Revalidate session revision and availability under gate                      |
| Manual outbound versus own inbound acceptance              | First slot claim wins; dismissal and outbound claim are atomic               |
| Failed manual start with pending offer                     | Dismissal/claims roll back; no outbound side effects                         |
| Transfer request versus recipient's existing inbound offer | Common admission; do not silently replace another offer                      |
| Transfer acceptance versus recipient outbound              | Shared slot; one assignment                                                  |
| Pending transfer versus successful recipient manual start  | Atomic decline plus outbound claim; source owner/slot/bridge preserved       |
| Inbound offer expiry versus redispatch/auto next           | Persistent per-call exclusion; no reoffer or stale inbound-priority veto     |
| Old finalization versus new claim                          | Old token cannot release the new slot                                        |
| Old worker resumes after timeout                           | Intent/generation/executor checks; unresolved commands prevent reuse         |
| Repeated fallback command                                  | Unique operation/fixed UUID; inspect actual state                            |
| Voicemail release/background completion versus new work    | Release only matching reservation; preserve newer slot and pause             |

### 5.8. Offer Expiry and Connection Retries

Expiry is a server-owned transition under admission using the offer deadline. Dispatch
and admission apply overdue expirations before checking offers and queue eligibility;
acceptance rejects a past-deadline offer even if a timer has not run. Record `expired` separately
from explicit `ignored`; neither is customer abandonment. Both exclude the same
`(call_id, agent_id)` from automatic reoffers for the lifetime of that customer call,
including campaign/session changes and requeue after another agent's failed connection.

Eligibility and automatic outbound priority use those same exclusions. After expiry,
offer the next eligible FIFO call or reevaluate the existing deferred auto-next intent.
The expired customer call continues with other eligible agents or waits for its original
queue deadline. Never reset deadlines or reopen a closed offer on HTTP/SSE replay.

Distinguish offer expiry from a failed connection after acceptance and from cancellation
because another agent won. The latter does not exclude an agent from a later distribution
attempt. For connection failures, retain attempt/generation and cleanup evidence, apply
a bounded retry count and backoff, and revalidate SIP readiness before another attempt.
Fix those bounds in phase A; no immediate failure/reoffer loop or retry of uncertain legs.
Retries cannot override an existing ignore/expiry exclusion or extend the queue deadline.
Transfer expiry closes the transfer attempt and preserves the source conversation;
it does not automatically create another transfer offer.

## 6. Inbound Path and States

A02 has an opt-in [isolated ingress prototype and evidence report](inbound-ingress-prototype.md).
It exercises a loopback trust/DID gate, correlation-header rejection, bounded refusal,
and answered waiting audio on the pinned FreeSWITCH base image. Provider trust, DID
delivery, billing and forwarding caller ID remain open; this prototype does not enable
product ingress or implement durable admission. A02 is complete only in its amended
local scope. Its original provider trust/DID, audio/billing, forwarding caller-ID and
unavailable-admission/retry obligations are retained under I04.1, I04.2 and I04.5.

1. Validate trusted SIP source and DID in the repo-owned dialplan.
2. Set internal correlation; do not trust arbitrary SIP headers as product variables.
3. Idempotently register by ingress UUID with queue/deadline. Handle initial ingestion
   before generic ESL code that expects an existing call; preserve pre-insert evidence
   and acknowledge durable admission under section 6.1. Claim capacity under section 6.2.
4. Start waiting audio. Verify SIP answer/billing boundary with the provider;
   this is not `agent_connected_at`.
5. Create offers for eligible free agents under admission.
6. Send SSE refresh hints; browsers read authorized Desk snapshots.
7. Acceptance reserves a slot and saves connection intent; no ESL before commit.
8. Connect only the winning browser, stop waiting audio, and bridge.
9. Persist confirmed bridge, participation, and `agent_connected_at`.
10. Failed connection requeues within the original wait budget; preserve attempt
    history and resolve uncertain cleanup before endpoint reuse.

Proposed separate inbound phase:

```text
received -> queued -> connecting -> agent_connected -> ended
                  -> fallback -> audio_playing -> ended
                              -> external_dialing -> external_connected -> ended
                                                  -> next step / ended
```

Supplement common call states with compatible readers. Keep offer/transfer states
separate from outbound voicemail states. Late `CHANNEL_ANSWER`/`CHANNEL_BRIDGE` cannot
reverse terminal transitions. Reevaluate FIFO when agents become free; previously
ignored or expired offers must not permanently block later eligible work for that agent.
Unanswered inbound does not block unrelated campaigns. Section 5.6 governs manual
outbound; automatic advancement retains inbound priority.

### 6.1. Recovery Before the First Database Insert

A03's opt-in [durable ingress prototype and protocol](inbound-durable-ingress-prototype.md)
uses a separate local journal agent with bounded FS requests and idempotent PostgreSQL
import. Its isolated evidence does not implement or enable product ingress; D03 must
integrate the protocol with product admission, discovery, authorization and recovery.

An ESL subscription and its process-local backlog are not durable ingress storage.
Recovery must also discover trusted, application-tagged live FreeSWITCH ingress channels
that have no `calls` row. Keep an internally assigned ingress UUID, original arrival
time, validated DID, and route revision available before the first database write.
Admit/reconstruct idempotently by that UUID; recovery does not reset queue age or move
an old arrival behind newer work. Never rebuild a live offer from terminal evidence.

Phase A must select and prove a protocol for the gap between SIP arrival and durable
admission, including a lost acknowledgement after commit. For admitted calls, retain
ingress and terminal evidence through API/DB/ESL outages in a bounded FS-side durable
journal/CDR source or equivalent mechanism independent of API process memory. Import
calls that ended during the outage into terminal history exactly once, without ringing,
originating, or replaying a fallback after the caller has left. A live-channel scan alone
cannot reconstruct already ended calls.

The safe default is bounded rejection before answer/admission if the selected durable
capture/admission protocol cannot be established. Specify the SIP response, pre-admission
timeout in the local A03 prototype; verify actual provider rejection/retry/disconnect
behavior later under I04.5. A03 depends on A02's completed local contract, not on
I04 provider acceptance. A03 must still prove durable capture, commit/ack, replay
and failure bounds; A02's simulated admission and fixture values cannot satisfy those
criteria. Do not assume retries are deduplicated or that the provider delivers early media.
Explicitly document the history guarantee for calls
rejected before admission, including journal exhaustion/failure; do not imply that a
rejected, unrecorded attempt has complete product history. Accepted/queued calls must
not silently disappear. Retain evidence until acknowledged import; define storage bounds,
deduplication, retention, restart recovery, and operator alerts. Do not enable ingress
while the chosen mechanism or its loss boundary remains undecided.

### 6.2. Capacity and Overflow

Define finite per-queue waiting limits and deployment-wide media/trunk limits, including
concurrent external forwarding. Count customer waiting/connecting/active/fallback legs,
browser and supervisor legs, and temporary transfer overlap in the resources they
actually consume. Agent-slot limits alone do not bound these resources.

Under common admission, atomically reserve capacity with queue/call/operation claims;
all paths consuming the same resource, including existing outbound, use the same budget.
Reserve an external forwarding leg before sending originate. Replays reuse a reservation;
only confirmed cleanup releases it, and uncertain legs continue consuming the budget.
Queue entries remain counted while connecting, or retain a return reservation, so a
failed connection cannot requeue beyond the limit. Do not evict admitted conversations
when a limit is lowered; stop further admissions until usage falls below the limit.

Before implementation, define counting units, numeric limits, and a bounded overload
action for each resource. Proposed default: reject new ingress when there is no safe
capacity; at a forwarding limit, take its configured failure continuation. An overflow
audio/forwarding action is allowed only with its own reserved resources and time bound;
it must not bypass the exhausted limit or create recursive overflow. Distinguish
`capacity_exceeded` from queue timeout and no available agents in history/metrics.

Account for channels created before API admission with FS-side hard safeguards as well
as DB reservations; validate them on the pinned image/provider. Expose relevant queue
limits/overflow policy in admin configuration, and deployment-wide limits in the existing
configuration/runbooks. Test above the limits and prove admitted calls remain controllable
and resources return to baseline after rejected work and reconciliation.

## 7. No-Answer Flows and Audio

Support a bounded finite action sequence:

| Action             | Parameters                                                    |
| ------------------ | ------------------------------------------------------------- |
| `play_audio`       | Prerecorded audio ID                                          |
| `forward_external` | Saved normalized target, answer timeout, failure continuation |
| `hangup`           | Explicit completion                                           |

```text
play_audio("All agents are busy") -> hangup
play_audio("Connecting to the on-call agent") -> forward_external(on_call_number)
  -> on busy/no-answer/failure: play_audio(fallback_audio) -> hangup
```

VM is `play_audio`, not caller-message capture. DTMF menus can be added later; the
confirmed first-version scenarios do not require mandatory keypad selection.

- Snapshot flow version/parameters; administrator edits do not change executing calls.
- `queued -> fallback` atomically closes acceptance.
- Each step has a unique operation and started/completed/interrupted/failed evidence.
  Successful command submission is not completed playback.
- External targets come from administrator settings, not arbitrary agent request strings.
- Reuse normalization/strict validation; prevent obvious loops through owned DIDs;
  bound step count and duration.
- External legs belong to the same call with their own UUID/outcome. Customer hangup
  cancels external dialing; late answers must not orphan legs.
- Reserve forwarding/trunk capacity before dialing. Exhaustion follows a bounded
  configured failure continuation under section 6.2, without an unreserved retry.
- Verify allowed caller ID and external forwarding with the provider.

Reuse WAV/MP3 decoding/normalization, storage, and media tickets. Keep inbound audio
assignment separate from outbound `campaigns.voicemail_recording_id`, respect campaign
ownership, and do not restore global fallback. Protect executing-flow audio references
from deletion and define replacement/disable behavior.

## 8. Agent Transfers

Preserve one product call through all directions and transfers.

1. Select a colleague; availability lists are hints, not reservations.
2. Under admission validate owner, bridge, both agents, recipient slot/Desk, and offers.
3. Create transfer offer; keep the source conversation connected.
4. Manual acceptance reserves recipient slot for the same call and saves intent.
5. Connect recipient and safely replace bridge, using brief hold if needed.
6. Confirm bridge before changing current owner/closing old participation; release the
   source reservation only after confirming the old agent leg ended.
7. Decline/timeout/failure before switching preserves the source conversation.
8. A recipient's successful manual outbound atomically declines a still-pending offer
   and transfer request under section 5.6. Failed admission preserves the offer; if
   transfer acceptance already reserved the recipient, manual outbound conflicts.

Transfer states: `offered`, `connecting`, `switching`, `completed`, `declined`,
`expired`, `canceled`, `failed`, `uncertain`. One unfinished transfer per call.
Browser SIP REFER is not an independent call-control authority.

Prototype customer-leg preservation, `hangup_after_bridge`, park/rebridge, recording
media bugs, and late old-agent hangups on the pinned image. Define recovery if the
source disappears during switching; do not promise return to a nonexistent leg.
Recover within a bounded state or terminate with an accurate technical outcome.
Only the current owner controls the call; former agents may submit bounded telemetry
for their own participation. Proposed supervisor behavior is to end at handover and
require a new explicit session, never silently carrying whisper to another agent.

The [A05 rebridge/executor prototype](inbound-rebridge-executor-prototype.md)
records the isolated FS/DB harness, selected uncertainty protocol and per-criterion
evidence. Its recording/runtime status must be checked there before treating A05
as a completed dependency; this link does not enable product transfers.

## 9. API and UI

B05 selects the [v1 shared API/transition contract](inbound-api-contracts.md).
Its future operations are cataloged separately from live OpenAPI paths.
[C04 manual admission](inbound-manual-outbound.md) supplies atomic native starts
and DB/API verification for the three existing manual routes. The production
bootstrap still fails coordinated starts closed until a native execution adapter
and the rollout gates are installed. [C05 durable auto-next](inbound-auto-next.md)
adds source-idempotent automatic admission, queue priority and cancellation through
the same staged execution seam. [C06 concrete cleanup](inbound-call-cleanup.md)
adds reservation snapshots, exact-leg terminal handling and uncertainty-safe
background release, plus authenticated native hangup/voicemail producers and
verified C03 execution tested through the actual HTTP/FreeSWITCH path. Global
bootstrap remains staged under I05.
Legacy starts
share admission serialization and cannot silently dismiss native work. This contract does not mount the new
Desk/offer/transfer/admin endpoints or enable product ingress/media.

Preserve `/agent/desk`, `/agent/events`, `/agent/call-next`, `/agent/manual-dial/start`,
`/agent/leads/:contactId/call`, and existing controls. All creation paths share admission,
but explicit manual and automatic starts use different priority policies.

Proposed new endpoints, not existing contracts:

| Endpoint                                                                  | Purpose                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| `POST /agent/desk-sessions`                                               | Register/take control of Desk                    |
| `PATCH /agent/desk-sessions/:sessionId`                                   | Heartbeat, campaign/readiness, revision checks   |
| `DELETE /agent/desk-sessions/:sessionId`                                  | Close matching controlling session               |
| `POST /agent/call-offers/:offerId/accept`                                 | Idempotent inbound/transfer acceptance           |
| `POST /agent/call-offers/:offerId/ignore`                                 | Ignore own inbound offer or decline own transfer |
| `GET /agent/calls/:callId/transfer-targets`                               | Eligible recipients                              |
| `POST /agent/calls/:callId/transfers`                                     | Offer transfer                                   |
| `DELETE /agent/calls/:callId/transfers/:transferId`                       | Cancel own unfinished transfer                   |
| `/admin/inbound-numbers`, `/admin/inbound-queues`, `/admin/inbound-flows` | Configuration CRUD/versioning                    |

Extend `AgentDeskResponse` with offer/transfer, server revision, slot/action availability,
and auto-next intent state. Expose independent manual-start and auto-next eligibility:
`incoming_pending` must not disable otherwise valid explicit manual controls.

Use idempotency keys and expected revisions where needed. Same key/different payload
is a conflict. Acceptance returns `connecting`, not a completed conversation. Stale
offers return conflict/fresh state; completed operations return existing results.
Document `startReason`, source, and session fields on `/agent/call-next`; map explicit
lead/manual-number actions to manual admission. Ambiguous legacy requests do not
silently dismiss offers. Intent metadata is not a security privilege or media proof.

Agent Desk: number/campaign/wait card, ringtone, Accept/Ignore, connecting, transfer
offers, recipient selection/cancel. Allow explicit manual outbound with pending inbound
or transfer offers when other checks pass; the start request performs atomic dismissal with no extra
confirmation or separate Ignore request. Reflect committed state; retain/refetch offers
on admission failure.

Only correlated service INVITEs may auto-connect media after the user's explicit
acceptance. Validate call/operation/session and SIP binding generation, including INVITE
before HTTP response, using the verified endpoint binding in section 9.1.
Avoid duplicate cards/ringtones from SSE/polling. Administrator UI covers number routes,
queue/deadlines/limits/overflow policy, waiting audio, flow/target forms, preview,
enabled and desired/applied/error states. Adding a UI route does not purchase or
activate a provider DID.

### 9.1. Controlling Desk Session and SIP Endpoint

D01 implementation update: [controlling Desk session lifecycle](inbound-desk-sessions.md)
records the implemented HTTP/provisioning/verification protocol, local evidence
and open real-browser WSS/WebRTC disconnect gate. Native enablement remains I05.

A04's isolated [Desk/SIP binding prototype and selected protocol](inbound-desk-binding-prototype.md)
uses per-generation SIP identities, authoritative contact verification and fenced
controller updates. It proves local FS + DB endpoint selection/takeover with UDP SIP
clients; it does not implement product Desk sessions or prove browser/provider media.
Product integration remains B02/D01/E04, with actual browser acceptance in I02.3.

Bind the controlling Desk session/revision to a server-verified SIP registration and
specific routable endpoint, with a binding generation. A shared agent SIP username or
the agent-level `registered` flag is insufficient. Phase A must choose and validate
session-specific SIP identities or verified contact-specific routing and provisioning;
do not accept an arbitrary browser-supplied SIP destination as the authoritative binding.

Eligibility requires both a current Desk session and its live matching endpoint. Originate
targets that binding, not whichever contact most recently registered under a shared
username. Include call/operation/session/binding correlation in service INVITEs and reject
stale bindings in the browser. Such validation protects acceptance but does not replace
correct delivery. Apply the binding contract to inbound, outbound, and transfer media.

An idle takeover must invalidate old offers/auto intents, revoke the old controller's
action rights, establish the new registration binding, and only then expose readiness.
Old-tab heartbeat, registration refresh, unregister, cleanup, or delayed INVITE must not
overwrite or tear down the new binding. Define bounded cleanup of superseded registrations.
If registration becomes ambiguous, mark the agent unavailable until reconciled.

Proposed initial active-call policy: reject ordinary takeover while a slot is reserved,
connecting, active, releasing, or uncertain. Do not silently move or end an existing
conversation. Heartbeat expiry does not release an occupied slot; disconnect recovery
uses confirmed leg/operation evidence. Live call migration between browsers is outside
this plan. Validate two genuinely registered clients, stale-tab refresh/close, idle
takeover, and takeover attempts during inbound, outbound, and transfer calls.

## 10. FreeSWITCH Configuration and Recovery

- Change repo-owned templates/renderers, not generated files manually.
- Render DID/flow config from DB into existing `FREESWITCH_GENERATED_CONFIG_DIR`/volume.
- Apply desired revision through validation/atomic write, `reloadxml`, then applied/error.
  Serialize application; old workers cannot overwrite newer config. Keep last valid config.
- Verify actual application, not only SQL save; reconcile after FS/API restart.
- Reject unknown DIDs/untrusted sources; browser ingress cannot originate PSTN.
- Bound waiting in FS when API is unavailable. If a flow cannot execute safely, use
  bounded termination rather than an indefinite leg; verify exact behavior in prototype.
- Implement the pre-insert journal/discovery/admission protocol in section 6.1; include
  terminal calls that are absent from DB, not only recovery starting from `calls` rows.
- Apply and verify endpoint binding and capacity safeguards from sections 9.1 and 6.2;
  reject/defer new work explicitly when those prerequisites cannot be established.
- Reconcile queue/connecting/transfer/fallback operations, legs, and reservations after
  reconnect/restart, accounting for the ESL backlog before absence decisions.
- Stable operation IDs/UUIDs: `bgapi` success is not bridge/playback success; lost
  responses do not prove absence. No blind retries with new UUIDs.
- Persist deadlines in DB; timers only wake workers. Keep unresolved slots uncertain
  until command/leg reconciliation under section 5.3.

Keep `.env`, Compose, and `scripts/deploy.sh`. Document/validate any new variables in
`.env.example` and environment docs. Firewall/host-port changes need separate scope/review.

## 11. History, Recording, and Observability

- Show direction, DID, campaign/queue, wait, participants, offers, transfers, flow steps,
  and terminal reason. Agent ignore or offer expiry is not customer abandonment.
- Separate queue exit from flow outcome, e.g. queue timeout plus successful audio.
- Manual outbound dismissal is an agent offer event, not customer cancellation; retain
  other agents' offers and the eventual customer result.
- Manual outbound transfer decline preserves the original call and source participation;
  record `manual_outbound_started` as the transfer closure reason, not a call outcome.
- Preserve immutable manual terminal-outcome correction.
- Record on retained customer leg under campaign policy. Verify continuity/content
  across rebridge/external forwarding; no new recorder per agent.
- Calls never eligible for recording must not become false recording failures.
- Attribute duration/statistics per participation, not entirely to the final owner.
- Authorize former-agent telemetry only for their own segment.
- Update analytics, exports, media authorization, retention, backup/restore, and cleanup;
  keep outbound metrics separate.
- Measure queue/wait, offers, connection failures, admission conflicts, auto deferrals,
  manual dismissals, transfers, flow outcomes, uncertain slots, configuration errors,
  admission/lock time. Avoid unbounded phone/call/agent Prometheus labels. Correlate by
  call/operation/reservation without secrets/raw SIP payloads.
- Measure pre-insert recovery/import lag, ingress journal capacity/failures, binding
  mismatches, expired offers, capacity rejections, resource reservations, executor backlog,
  and DB pool acquisition/waiters. Alert on loss of the configured admission guarantee.

## 12. Implementation Phases and Continuation Points

All phases remain open. Each phase includes new tests, actual validation results,
limitations, and handoff. Tests ship with implementation, not as a final follow-up.

| Phase                  | Work                                                                                                | Completion criterion                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A. Design/prototype    | Lock graph, ingress durability/loss boundary, SIP binding, rebridge/fencing, resource budgets       | Recorded path evidence; chosen protocols, overload actions, retry bounds and DB budgets      |
| B. Schema/contracts    | Migrations, slots/offers/participants/operations/intents, ingress/binding/capacity, API             | Migration/constraint integration and contract unit tests pass; feature off                   |
| C. Admission           | Migrate outbound/release/supervisor; priority, manual dismissal/decline, capacity, bounded executor | PostgreSQL races and slow-ESL/pool-isolation tests pass before inbound UI                    |
| D. Presence/ingress    | Verified Desk/SIP binding, ingestion journal/import, queue and overflow                             | Pre-insert outage/replay tests and two-client SIP binding/takeover checks pass               |
| E. Ring-all/acceptance | Offers, SSE/UI, accept/ignore/expiry, exclusions, bounded retry/requeue                             | API/DB/browser tests prove one winner, no expiry reoffer and manual-dismissal behavior       |
| F. No-answer/admin     | Audio/flow, forwarding capacity, limits/overflow UI, config application                             | Unit/integration/UI/FS tests cover outcomes, overflow and apply failures                     |
| G. Transfers           | Reservation, manual-outbound decline, participation, rebridge, permissions/supervisor               | DB/browser/FS tests pass for both directions and preserve source on decline                  |
| H. Operations/history  | Recording, telemetry, reports, retention/recovery/docs                                              | Integration/regression/failure-injection coverage; no leaked reservations                    |
| I. Load/acceptance     | 20-agent mixed load, above-limit/slow-ESL runs, provider matrix, staged enable/rollback             | Correctness, bounded rejection/recovery and performance pass; deployment permission recorded |

Primary areas:

- API: `apps/api/src/dashboard/calls.ts`, `routes.ts`, `responders.ts`, `campaigns.ts`,
  `supervisor.ts`, `recordings.ts`; `agent-availability.ts`, `call-finalization.ts`,
  `user-media-lock.ts`, `esl.ts`, `esl-events.ts`, `live-events.ts`, `db.ts`,
  `freeswitch/provisioning.ts`, `agent-registrations.ts`.
- New modules: admission, Desk presence, inbound dispatcher/ingestion, offer actions,
  transfers, durable operations, ingress evidence/import, endpoint binding, capacity,
  bounded executor, flow runner/provisioning. Avoid growing two giant route/event modules.
- DB: `apps/api/db/migrations/`; do not rewrite applied migrations.
- Contracts: `packages/shared/src/index.ts`, generated OpenAPI, browser API/types.
- Web: `apps/web/src/features/agent-desk/`, `softphone.ts`, `browser-media.ts`, `App.tsx`,
  campaign/settings/recordings forms, history.
- FS: `infra/freeswitch/templates/`, `entrypoint.sh`, provisioning; Compose only if needed.
- Docs: requirements, architecture/ADR, implementation status, guides/API guide,
  known limitations, acceptance, deployment/recovery/load runbooks.

## 13. Required Tests and Acceptance Evidence

### 13.1. Unit Tests

Add focused tests following existing API/web conventions:

- Eligibility: campaign, Desk expiry/revision, readiness, pause, occupied slot.
- Persistent inbound ignore/expiry exclusions, distinct closure reasons, next eligible
  call selection, and bounded failed-connection retries without deadline extension.
- Desk/SIP binding generations, stale registration/cleanup, and takeover eligibility.
- Ingress deduplication/live-versus-terminal import and original arrival/deadline recovery.
- Capacity accounting/overflow decisions and executor concurrency/backlog limits.
- Auto versus explicit manual decisions and `incoming_pending`.
- Offer/slot/transfer/flow transitions, terminal guards, stale generations.
- Idempotency fingerprints, source-work validation, intent defer/retry/cancel.
- Flow version/validation, audio ownership, number normalization, loop bounds.
- ESL correlation/classification and deterministic command/UUID construction.
- UI manual controls remain available with an inbound or transfer offer; eligible
  inbound still defers auto next. Stale callbacks stop, ringtones do not overlap,
  and failed starts preserve offers.
- Conflict/validation/duplicate-result presentation.

Use mocks/fake clocks for deterministic pure behavior/command contracts. They do not
prove DB concurrency, actual bridge behavior, or media quality.

### 13.2. Database/API Integration and Concurrency Tests

Use real PostgreSQL, separate connections, and controlled barriers, not just mocked
`Promise.all` or arbitrary sleeps. Test both commit orders, rollback, and revalidation
after lock waits. Verify fresh/upgrade migrations, constraints, endpoint authorization,
and cross-process coordination. Stub ESL for DB/API cases and assert invocation counts.

| Test                                                      | Required assertion                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Inbound committed before offers; auto next                | Deferred; no call/contact claim or originate                                  |
| Auto next reserved before originate; inbound              | Agent excluded; no second assignment                                          |
| Manual outbound with pending inbound                      | Atomic dismissal of own offer plus outbound claim; no extra Ignore            |
| Manual validation/suppression/maintenance/contact failure | Dismissal rolls back; no new slot, attempt, operation, or originate           |
| Manual start versus own inbound acceptance, both orders   | One slot claim; losing path has no side effects                               |
| Manual start versus another agent accepting customer      | Other agent's reservation preserved; this agent can start outbound            |
| Manual start with queued call not yet offered             | Outbound permitted; unseen calls not marked ignored                           |
| Duplicate manual start after dismissal                    | Same call/operation; one contact attempt                                      |
| Manual start with pending transfer, repeated request      | One decline/outbound; source owner, slot, participation and bridge preserved  |
| Failed manual start with pending transfer                 | No decline, outbound claim or attempt increment                               |
| Manual start versus transfer acceptance, both orders      | Winner claims recipient; loser cannot change source call or accepted transfer |
| Manual start after deferred auto next                     | Old auto intent canceled; no delayed extra outbound                           |
| Legacy next-call request lacks initiator                  | No silent offer dismissal or occupancy bypass                                 |
| Twenty simultaneous acceptances                           | One winner, one slot, one connection intent                                   |
| One agent accepts two calls                               | One successful reservation                                                    |
| Two tabs repeat one auto source                           | One call and attempt increment                                                |
| Stale auto after campaign/session change                  | Canceled/rejected; no dial                                                    |
| Inbound accepted before stale auto callback               | No outbound now or unexpectedly after inbound                                 |
| Ignore/auto next with another queued call                 | Queue rechecked; automatic work still defers                                  |
| Inbound expiry versus acceptance/redispatch               | One valid outcome; expired offer never reopened or reoffered                  |
| Expired offer across requeue, campaign/session changes    | Per-call exclusion persists; later work can proceed                           |
| Auto next after expiry, with/without other eligible calls | Other eligible inbound defers; expired-for-agent call does not veto           |
| Repeated accepted-connection failure                      | Retry count/backoff enforced; no uncertain reuse or deadline reset            |
| Acceptance versus timeout/hangup                          | One valid transition; no terminal regression                                  |
| Transfer acceptance versus recipient inbound/auto/manual  | One endpoint assignment                                                       |
| Old finalization after new reservation                    | New slot remains occupied                                                     |
| Lease expiry during uncertain command                     | No automatic slot release                                                     |
| Competing workers/reconciliation                          | No duplicate side effect or stale intent execution                            |
| Controlled mixed lock timings                             | No lock inversion; bounded retry without duplicates                           |
| Missing first insert, duplicate ingress and import replay | One call by ingress UUID; original arrival/route preserved                    |
| Terminal ingress evidence before live discovery/replay    | Terminal history only; no offer, dial or terminal regression                  |
| Concurrent queue/forwarding claims at the limit           | Budget never overclaimed; excess work takes bounded overload path             |
| Capacity release replay, uncertainty and lowered limit    | No double release/reuse; admitted conversations remain intact                 |
| Slow ESL exhausts executor budget                         | API/heartbeat/event/recovery DB capacity remains available                    |

Assert calls, offers, slots, participants, contact attempts, operations, and ESL sends,
not only HTTP codes. Later inbound must not secretly cancel admitted outbound. Manual
override never relaxes readiness, pause, maintenance, authorization, or occupancy.
Add integration tests for config revisions, recovery, post-transfer telemetry permissions,
recording references, attribution, retention, and immutable terminal outcomes.

### 13.3. Browser and End-to-End Tests

- Multi-agent ring-all, manual acceptance, ignore, and dismissal after another winner.
- Direct manual outbound with inbound offer: no extra Ignore, only this agent's offer
  disappears, other agents continue ringing.
- Failed manual start preserves/refetches the offer; stale accept cannot interrupt outbound.
- Offer timeout removes the card/ringtone without repeated offers after refresh or
  session change; the next eligible call or deferred auto intent can proceed.
- Manual outbound with a transfer offer declines only that transfer; the source keeps
  talking. Failure preserves the offer; racing transfer acceptance has one winner.
- Auto next pauses for inbound while an explicit next-lead click follows manual policy.
- Campaign/pause, tabs/session takeover, stale SSE/polling, duplicate requests, autoplay,
  and service INVITE preceding HTTP response.
- Transfer accept/decline/timeout/cancel and control permissions for both directions.
- Administrator number/flow/audio forms, previews, validation, apply errors.
- Queue limit/overflow forms and capacity errors preserve existing calls and explain
  rejection without presenting it as agent ignore or ordinary no-answer.
- History, recording playback, and inbound/transfer results.

Use current Playwright infrastructure and deterministic fixtures. Clearly distinguish
fake-media browser checks from actual SIP/RTP validation.

### 13.4. FreeSWITCH, Failure Injection, and Regression

- Ingress, waiting audio, connect timeout, customer CANCEL/hangup, rebridge, old-agent
  late hangup, recording continuity on the pinned image.
- Disconnect ESL or stop API before the first INSERT, and after commit before admission
  acknowledgement. Recover both a still-live channel and a caller who ended during the
  outage, without duplicates or renewed queue deadlines. Test DB outage, journal replay,
  FS restart, and journal exhaustion/failure against the documented admission guarantee.
- Two genuinely registered clients for one agent: selected controller receives media;
  stale-tab refresh/unregister/close cannot steal routing or remove the current binding.
  Test idle takeover, reconnect, and refused takeover while a call/transfer slot is occupied.
- Full/interrupted/failed audio; external busy/no-answer/answer; customer exit during
  dialing; no orphan lines or forwarding loops.
- Failure after claim/before send, after send/before ACK, after bridge/before DB update;
  reconnect/backlog, worker crash, lost execution-lock connection.
- Delayed/unresponsive ESL with a full executor pool: command deadlines are bounded;
  event persistence, Desk heartbeats, call termination and reconciliation still progress.
- Ingress and external forwarding above capacity: enforce FS and DB bounds, preserve
  admitted conversations, and clean up rejected/late-answer legs without resource leaks.
- Existing manual/lead/next outbound, voicemail/background jobs, supervisor modes,
  pause, terminal outcome lock, recordings/exports.

### 13.5. Load and Soak Tests

Create/extend reproducible tooling for the **new** inbound/transfer behavior. Existing
Desk HTTP load alone does not cover offers, arbitration, or media.

Required workloads:

1. Twenty eligible agents in one campaign, burst arrivals, ring-all, competing accepts.
2. Mixed inbound/outbound with auto next: arrivals immediately before/during/after
   release/admission, plus repeated explicit manual overrides.
3. Multiple waiting calls, busy/free/paused changes, ignore, campaign switching,
   reconnect/session takeover churn.
4. Concurrent transfers and external forwarding up to agreed active-call/trunk
   capacity, including configured recording.
5. Bounded soak with API/ESL reconnects and worker failures: no accumulating leaked
   slots, orphan legs, backlog, or duplicate operations.
6. Deliberately exceed queue/channel/forwarding limits in a controlled test environment:
   bounded rejection/failure continuation, no recursive overflow, and existing-call control
   and media remain within agreed budgets. Include uncertain reservations and limit changes.
7. Saturate executor concurrency with slow/unresponsive ESL while sending Desk heartbeats,
   ingress, hangups and event writes. Verify reserved DB capacity, bounded backlog, and
   recovery after the fault clears; include aggregate limits across worker/API replicas.

Separate DB/API/control-plane from realistic SIP/RTP runs; label simulated presence.
Twenty offer recipients must not produce twenty browser media legs for one call.
Real-provider load calls require separate authorization.

Record seed, revision, environment/resources, agent/call concurrency, arrival rate,
duration, recording/media options, and cleanup. Measure offer/admission/connection
latencies including p95/p99, lock/transaction times, DB pool, ESL backlog, CPU/memory,
errors, capacity rejection reasons/reservation counts, pool acquisition/waiter statistics,
ingress journal/import lag, and post-run slots/legs.

Correctness gates: zero duplicate interactive assignments, duplicate dial/bridge
operations, unrelated offer cancellations, and unexplained orphan legs/reservations
after reconciliation. Define latency/resource budgets before acceptance runs; do not
infer an SLA from an arbitrary result. Save the reproducible load report with handoff.
Do not hide capacity failures behind retries. Above-limit rejection is an expected outcome;
budget violations, loss of admitted calls, pool starvation, or unbounded backlog fail the gate.

### 13.6. Validation Commands and CI Integration

After shared changes:

```bash
npm --workspace @outbound-dialer/shared run build
```

Focused tests and common gate:

```bash
npm --workspace @outbound-dialer/api test
npm --workspace @outbound-dialer/web test
npm run quality
git diff --check
```

Environment-backed checks, when dependencies are available:

```bash
npm run test:e2e
npm run test:freeswitch
npm run test:load:desk
npm run test:load:sip-rtp
```

A07 adds `npm run test:inbound:db` (required explicit test DB) and
`npm run test:inbound:db:isolated` (disposable network-isolated PostgreSQL), reusable
process checkpoints, simulated ESL ledger/event replay and local SIP fixture reuse.
See [the A07 harness runbook](runbooks/inbound-test-harness.md) for dependencies,
discovery, cleanup, CI evidence and proof boundaries. These self-checks exercise test
infrastructure, not product admission. `test:load:inbound` remains proposed for I03,
**not an existing script**.

Integrate unit/contract tests into quality; real PostgreSQL integration/bounded races
into a CI job with PostgreSQL; browser/FS into appropriate jobs. Run heavier load/soak
in a controlled environment before enablement. Record skipped/blocked gates. Old green
commands do not prove new paths are covered.

Provider acceptance separately verifies DID, codecs, two-way audio, caller ID, external
forwarding, hangup, and transfer behavior. Separate local/synthetic from provider and
production evidence. Listed future tests have not run merely because they appear here.
The checks deferred from A02 remain mandatory in I04: transport source/authentication
and delivered DID field/normalization; early versus answered waiting audio and billing
confirmation; forwarding caller-ID/From/PAI and forbidden-ID behavior; exact unavailable
admission responses, retry/disconnect/failover, timing and rejected-attempt history
boundary. Closing A02 supplies only local prototype evidence, not these results.

## 14. Enablement, Compatibility, and Rollback

1. Ship additive schema/compatible readers with feature disabled.
2. Migrate all admission/release paths. Legacy requests cannot bypass slots or silently
   dismiss offers; new explicit manual starts use their policy, automatic starts defer.
3. Upgrade API/web; no ingress across versions with conflicting slot protocols.
4. Apply/verify FS configuration; separately verify provider delivery.
   Confirm the pre-insert evidence/import mechanism, SIP endpoint binding, FS/DB capacity
   limits, overflow actions, and reserved executor/control-plane DB budgets.
5. Complete unit/integration/E2E, controlled load/recovery, and provider acceptance
   before enabling the target route. I04.1–I04.5 include all provider requirements
   transferred from A02; a closed A02 or merged local prototype cannot bypass them.
6. Before rollback, stop new inbound/transfers and drain new scenarios/unresolved
   operations and pending ingress evidence imports; preserve unacknowledged journals.
   Migrations are not reversed automatically.
7. Verify the supported rollback version against new states/participants and historical
   readers. Ship compatibility releases if needed; record the minimum version.

Deployment, restarts, and production changes require separate authorization.

## 15. Handoff to Another Agent Chat

Provide this file and name a phase from section 12. The next agent must:

1. Read current `AGENTS.md`, status, related docs/KB; compare HEAD with the baseline.
2. Separate confirmed requirements, proposed defaults, and schema/API proposals.
3. Obtain an explicit implementation task; this document does not authorize code changes.
4. Record the actual lock graph across all media paths before phase C.
5. Preserve automatic deferral versus atomic manual inbound dismissal/transfer decline.
   Keep expiry distinct from Ignore and preserve the confirmed no-reoffer exclusion.
6. Do not claim race safety without real PostgreSQL tests in section 13.2.
7. Deliver unit/integration tests with each phase and appropriate E2E/FS/load evidence.
8. Record files, commands/results, unverified runtime, next phase, and new constraints.
   Do not silently change requirements.
9. Do not commit/push/deploy without permission; capture verified summaries per project rules.

Open target-provider checks under I04: actual trust/DID delivery, codecs/caller ID,
early/far-end audio and billing, forwarding policy, unavailable-admission rejection
and retries/disconnect. These are deferred acceptance work, not A02 blockers for
isolated development. Open implementation checks: chosen durable ingress
protocol and pre-admission history boundary; verified Desk-to-SIP binding and takeover;
numeric retry/capacity limits and overload responses; executor concurrency/DB reserves;
pinned-image rebridge and stopping stale executors before uncertain reuse; old-reader
compatibility; existing auto next after outbound voicemail release. Phase A must record
the selected mechanisms and budgets before dependent implementation; schema/test planning
can proceed. Inbound expiry/no-reoffer and manual outbound transfer-decline policies are
confirmed, not open product questions. No listed prototype or acceptance test has passed
merely because its requirement was added to this document.

## 16. Reference Material

- [FreeSWITCH CLI/API: originate, uuid_bridge, uuid_transfer, uuid_park](https://developer.signalwire.com/freeswitch/reference/cli-and-api/).
- [FreeSWITCH channel variables: hangup_after_bridge, park_after_bridge, park_timeout](https://developer.signalwire.com/freeswitch/reference/channel-variables/).
- [FreeSWITCH dialplan applications](https://developer.signalwire.com/freeswitch/dialplan/dptools/).

External docs describe capabilities, not verified behavior of the pinned image.
New routes, fields, states, and mechanisms remain proposals until backed by implementation
artifacts and appropriate checks.
