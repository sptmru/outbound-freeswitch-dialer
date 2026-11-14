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

## 1. Confirmed Requirements

- Start with one inbound number and one shared queue; support adding numbers later.
- Keep the existing SIP provider. Inbound routing with that provider is not verified.
- The same agents handle inbound and outbound; initial scale is about 20 agents.
- Associate the queue with a campaign. Recipients have that campaign **currently
  selected in Agent Desk**, rather than a separate administrator-assigned membership.
- Offer the call to all eligible agents simultaneously. Exclude agents with active
  calls. Acceptance must be manual.
- An agent can accept or ignore an offer.
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

## 2. Proposed Behavior Defaults

These are implementation defaults, not additional confirmed requirements. They can
be revised independently of the concurrency invariants in section 5.

| Situation                                                             | Proposed behavior                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Agent paused, outside Desk, phone not ready, or slot occupied         | Do not create a new offer                                                                             |
| Multiple waiting calls                                                | FIFO by arrival time, stable tie-breaker by call ID                                                   |
| One agent, multiple waiting calls                                     | At most one open offer; oldest eligible call first                                                    |
| Agent ignores                                                         | Close only their offer; preserve the customer call and other offers                                   |
| Agent already ignored this call                                       | Do not automatically offer the same call to them again                                                |
| Matching agent becomes free                                           | Offer eligible waiting work                                                                           |
| All agents busy or have ignored                                       | Wait until the overall queue deadline, then run the no-answer flow                                    |
| Queue deadline expires                                                | Atomically close acceptance and begin fallback                                                        |
| Inbound offer or eligible queued inbound exists; auto next is pending | Defer automatic advancement                                                                           |
| Agent explicitly starts manual outbound with an inbound offer         | No extra Ignore click; dismiss their offer and claim outbound in one successful admission transaction |
| Manual outbound validation/admission fails                            | Roll back dismissal; do not close the offer because of the failed start                               |
| Manual outbound races with the same agent's inbound acceptance        | First successful slot claim wins; never two calls                                                     |
| Transfer offer pending                                                | Keep the original conversation connected                                                              |
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
- [Originate](../apps/api/src/esl.ts) sets `hangup_after_bridge=true`. Customer-leg
  preservation during rebridging needs an early prototype.
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

| Entity                     | Data and constraints                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `inbound_numbers`          | Normalized unique DID, label, queue, enabled, route revision                                    |
| `inbound_queues`           | Campaign, waiting audio, deadlines, no-answer flow; multiple numbers may share a queue          |
| `inbound_flows` / versions | Bounded action sequence, audio references, configured external targets                          |
| `agent_desk_sessions`      | Agent, campaign, session ID, monotonic revision, expiry; one controlling session per agent      |
| `agent_call_slots`         | One persistent row per agent: call/participant, reservation ID, generation, state               |
| `call_offers`              | Call, agent, Desk revision, deadline, state, closure reason; at most one open offer per agent   |
| `call_participants`        | Call, agent/external party, concrete leg, role, participation interval                          |
| `call_transfers`           | Call, initiator, recipient, state, operation ID, deadlines; one unfinished transfer per call    |
| `call_operations`          | Idempotency key, request fingerprint, command kind, generation, fixed UUIDs, execution state    |
| `agent_auto_next_intents`  | Source completion, campaign, Desk revision, pending/deferred/started/canceled, stable retry key |

Extend `calls` with direction, original DID, calling/called numbers, queue, and current
owner. Inbound can exist without an agent or contact. Keep `calls.agent_id` as a
compatibility projection, not the sole occupancy record: transfers occupy the source
and reserve the recipient. Relate legs/statistics to concrete participations; migrate
history without loss and provide compatible read models where practical.

Record PSTN answer separately from `agent_connected_at`, queue deadline, participation,
and fallback timestamps. FreeSWITCH answering to play audio is not agent acceptance.
Inbound does not increment outbound `attempt_count` or automatically change contact
status. Matching contacts provide context. Fix campaign at ingestion, including transfers.

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

### 5.1. One PostgreSQL Admission Arbiter

For this single-tenant initial scale, propose one transaction-scoped advisory lock,
conceptually `pg_advisory_xact_lock(namespace, tenant_key)`. Select the namespace after
inspecting existing advisory locks.

All short transactions affecting assignment/release eligibility or inbound visibility
must use the gate: inbound enqueue/fallback/terminal; offer creation, acceptance,
ignore, and manual dismissal; every outbound path; transfer reservation/completion;
slot release including voicemail release; campaign/pause/Desk-session changes; and
reconciliation/supervisor changes affecting media endpoint occupancy.

Read authoritative state **after acquiring the gate**, not from an earlier Desk
snapshot. Initially use `READ COMMITTED`; do not rely on snapshots established before
waiting for the lock. Use database time for deadlines and expiry.

Automatic outbound must inspect the queue itself, not only `call_offers`: inbound
can commit before offers are created. Eligible queued work already defers auto next,
except calls the agent previously ignored. Admission may create an offer synchronously
before returning deferred.

Explicit manual outbound still takes the gate and checks occupancy, but queued
inbound alone is not a veto. Dismiss the current inbound offer atomically with a
successful manual start. Do not mark unseen queued calls ignored or close other
agents' offers. Occupied outbound slots are excluded from future offers.

The gate coordinates separate processes; state survives restarts. Never hold it
across ESL, file processing, network, or user interaction. Telemetry and ordinary
reads do not take it. Measure transaction duration/contention under load before
considering campaign-level sharding and revising the lock graph.

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

Inventory `lockUserMediaAction`, `lockUserMediaSession`, `lockCampaignVoicemail`,
maintenance, finalization, supervisor, and reconciliation locks before implementation.
Proposed common order:

1. Where required, per-call execution locks outside transactions, sorted by call ID.
2. `BEGIN`; new starts take the existing maintenance gate in its compatible mode.
3. Common admission advisory lock.
4. Required campaign audio locks, then user-media locks, in stable ID order.
5. Agent rows, then slot rows, sorted by agent ID.
6. Calls, transfers, offers/operations in stable ID order.
7. Contacts for outbound; persist claims and command intent.
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

On lost lock connection or ambiguous outcome, stop new actions and retain `uncertain`.
PostgreSQL fencing tokens do not automatically fence FreeSWITCH. The prototype must
establish how old workers stop and in-flight commands resolve before reuse. A momentary
`uuid_exists=false` is insufficient if an old command can still be sent/executed.

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
- After ignore/offer closure, reevaluate **the same** intent against fresh state;
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

### 5.6. Explicit Manual Outbound With an Inbound Offer

Manual includes an explicit click to call a lead, dial a number, or call the next lead.
Auto next remains a different initiator despite sharing `/agent/call-next`. Do not
require an extra Accept/Ignore click solely because an inbound offer exists.

Suggested successful transaction:

1. Validate actor, idempotency fingerprint, manual initiator, current Desk session,
   campaign, maintenance, phone readiness, pause, and occupancy under common locks.
2. Validate/reserve the requested contact/number with existing campaign, normalization,
   suppression, retry, and contact ownership rules.
3. Close only this agent's still-pending inbound offer as `ignored`, with a reason
   such as `manual_outbound_started`. If another agent already accepted the customer
   call and closed this offer, no dismissal is needed.
4. Claim the outbound slot, save call/command intent, and cancel the old deferred
   auto-next intent in the same transaction.
5. Commit together, then originate. Do not issue a separate Ignore request followed
   by an unprotected outbound request.

All mutations follow section 5.3; the list above groups conceptual checks, not a new
lock order. A pre-commit failure rolls back offer dismissal, contact claim, and slot
claim. The offer may independently expire/close, but failed outbound must not be its
closure reason.

If this agent's inbound acceptance claims the slot first, outbound loses with an
occupancy conflict and cannot dismiss an accepted offer. If manual outbound wins,
stale acceptance loses; the customer stays with the remaining agents or queued.
Another agent accepting the customer call does not prevent outbound on this free
agent's endpoint. Preserve that other agent's reservation and call.

After successful commit, later originate failure does not restore an obsolete ignored
offer. Reevaluate fresh state. Do not decline all queued calls or reset customer
deadlines. The manual exception changes priority, not occupancy limits.

Keep any pending transfer-offer dismissal policy explicit and separate. This user
correction concerns inbound offers and does not imply accepting transfers implicitly.

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
| Old finalization versus new claim                          | Old token cannot release the new slot                                        |
| Old worker resumes after timeout                           | Intent/generation/executor checks; unresolved commands prevent reuse         |
| Repeated fallback command                                  | Unique operation/fixed UUID; inspect actual state                            |
| Voicemail release/background completion versus new work    | Release only matching reservation; preserve newer slot and pause             |

## 6. Inbound Path and States

1. Validate trusted SIP source and DID in the repo-owned dialplan.
2. Set internal correlation; do not trust arbitrary SIP headers as product variables.
3. Idempotently register by ingress UUID with queue/deadline. Handle initial ingestion
   before generic ESL code that expects an existing call.
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
ignored calls must not permanently block later eligible work for that agent.
Unanswered inbound does not block unrelated campaigns. Section 5.6 governs manual
outbound; automatic advancement retains inbound priority.

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

## 9. API and UI

Preserve `/agent/desk`, `/agent/events`, `/agent/call-next`, `/agent/manual-dial/start`,
`/agent/leads/:contactId/call`, and existing controls. All creation paths share admission,
but explicit manual and automatic starts use different priority policies.

Proposed new endpoints, not existing contracts:

| Endpoint                                                                  | Purpose                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------- |
| `POST /agent/desk-sessions`                                               | Register/take control of Desk                  |
| `PATCH /agent/desk-sessions/:sessionId`                                   | Heartbeat, campaign/readiness, revision checks |
| `DELETE /agent/desk-sessions/:sessionId`                                  | Close matching controlling session             |
| `POST /agent/call-offers/:offerId/accept`                                 | Idempotent inbound/transfer acceptance         |
| `POST /agent/call-offers/:offerId/ignore`                                 | Ignore only one's own offer                    |
| `GET /agent/calls/:callId/transfer-targets`                               | Eligible recipients                            |
| `POST /agent/calls/:callId/transfers`                                     | Offer transfer                                 |
| `DELETE /agent/calls/:callId/transfers/:transferId`                       | Cancel own unfinished transfer                 |
| `/admin/inbound-numbers`, `/admin/inbound-queues`, `/admin/inbound-flows` | Configuration CRUD/versioning                  |

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
when other checks pass; the start request performs atomic dismissal with no extra
confirmation or separate Ignore request. Reflect committed state; retain/refetch offers
on admission failure.

Only correlated service INVITEs may auto-connect media after the user's explicit
acceptance. Validate call/operation/session, including INVITE before HTTP response.
Avoid duplicate cards/ringtones from SSE/polling. Administrator UI covers number routes,
queue/deadlines, waiting audio, flow/target forms, preview, enabled and desired/applied/error
states. Adding a UI route does not purchase or activate a provider DID.

## 10. FreeSWITCH Configuration and Recovery

- Change repo-owned templates/renderers, not generated files manually.
- Render DID/flow config from DB into existing `FREESWITCH_GENERATED_CONFIG_DIR`/volume.
- Apply desired revision through validation/atomic write, `reloadxml`, then applied/error.
  Serialize application; old workers cannot overwrite newer config. Keep last valid config.
- Verify actual application, not only SQL save; reconcile after FS/API restart.
- Reject unknown DIDs/untrusted sources; browser ingress cannot originate PSTN.
- Bound waiting in FS when API is unavailable. If a flow cannot execute safely, use
  bounded termination rather than an indefinite leg; verify exact behavior in prototype.
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
  and terminal reason. Agent ignore is not customer abandonment.
- Separate queue exit from flow outcome, e.g. queue timeout plus successful audio.
- Manual outbound dismissal is an agent offer event, not customer cancellation; retain
  other agents' offers and the eventual customer result.
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

## 12. Implementation Phases and Continuation Points

All phases remain open. Each phase includes new tests, actual validation results,
limitations, and handoff. Tests ship with implementation, not as a final follow-up.

| Phase                  | Work                                                                                     | Completion criterion                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A. Design/prototype    | Lock inventory, states, pinned-FS ingress/bridge/rebridge, command fencing               | Recorded path evidence, safe protocol, explicit limits                                       |
| B. Schema/contracts    | Migrations, slots/offers/participants/operations/intents, API/OpenAPI                    | Migration/constraint integration and contract unit tests pass; feature off                   |
| C. Admission           | Migrate outbound/release/supervisor; auto deferral, atomic manual dismissal, idempotency | Unit and real PostgreSQL concurrency tests in section 13.2 pass before inbound UI            |
| D. Presence/ingress    | Desk revision/readiness, ingestion/queue                                                 | Unit/integration coverage of stale sessions and duplicate ingress                            |
| E. Ring-all/acceptance | Offers, SSE/UI, accept/ignore, cleanup/requeue                                           | API/DB/browser tests prove one winner and manual-dismissal behavior                          |
| F. No-answer/admin     | Audio/flow, external legs, config application                                            | Unit/integration/UI/FS tests cover outcomes and apply failures                               |
| G. Transfers           | Recipient reservation, participation, rebridge, permissions/supervisor                   | DB/browser/FS tests pass for both directions                                                 |
| H. Operations/history  | Recording, telemetry, reports, retention/recovery/docs                                   | Integration/regression/failure-injection coverage; no leaked reservations                    |
| I. Load/acceptance     | Reproducible 20-agent mixed load, provider matrix, staged enable/rollback                | Correctness and agreed performance budgets pass; evidence and deployment permission recorded |

Primary areas:

- API: `apps/api/src/dashboard/calls.ts`, `routes.ts`, `responders.ts`, `campaigns.ts`,
  `supervisor.ts`, `recordings.ts`; `agent-availability.ts`, `call-finalization.ts`,
  `user-media-lock.ts`, `esl.ts`, `esl-events.ts`, `live-events.ts`.
- New modules: admission, Desk presence, inbound dispatcher/ingestion, offer actions,
  transfers, durable operations, flow runner/provisioning. Avoid growing two giant route/event modules.
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
- Auto versus explicit manual decisions and `incoming_pending`.
- Offer/slot/transfer/flow transitions, terminal guards, stale generations.
- Idempotency fingerprints, source-work validation, intent defer/retry/cancel.
- Flow version/validation, audio ownership, number normalization, loop bounds.
- ESL correlation/classification and deterministic command/UUID construction.
- UI manual controls remain available with an inbound offer while auto next defers;
  stale callbacks stop, ringtones do not overlap, and failed starts preserve offers.
- Conflict/validation/duplicate-result presentation.

Use mocks/fake clocks for deterministic pure behavior/command contracts. They do not
prove DB concurrency, actual bridge behavior, or media quality.

### 13.2. Database/API Integration and Concurrency Tests

Use real PostgreSQL, separate connections, and controlled barriers, not just mocked
`Promise.all` or arbitrary sleeps. Test both commit orders, rollback, and revalidation
after lock waits. Verify fresh/upgrade migrations, constraints, endpoint authorization,
and cross-process coordination. Stub ESL for DB/API cases and assert invocation counts.

| Test                                                      | Required assertion                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| Inbound committed before offers; auto next                | Deferred; no call/contact claim or originate                        |
| Auto next reserved before originate; inbound              | Agent excluded; no second assignment                                |
| Manual outbound with pending inbound                      | Atomic dismissal of own offer plus outbound claim; no extra Ignore  |
| Manual validation/suppression/maintenance/contact failure | Dismissal rolls back; no new slot, attempt, operation, or originate |
| Manual start versus own inbound acceptance, both orders   | One slot claim; losing path has no side effects                     |
| Manual start versus another agent accepting customer      | Other agent's reservation preserved; this agent can start outbound  |
| Manual start with queued call not yet offered             | Outbound permitted; unseen calls not marked ignored                 |
| Duplicate manual start after dismissal                    | Same call/operation; one contact attempt                            |
| Manual start after deferred auto next                     | Old auto intent canceled; no delayed extra outbound                 |
| Legacy next-call request lacks initiator                  | No silent offer dismissal or occupancy bypass                       |
| Twenty simultaneous acceptances                           | One winner, one slot, one connection intent                         |
| One agent accepts two calls                               | One successful reservation                                          |
| Two tabs repeat one auto source                           | One call and attempt increment                                      |
| Stale auto after campaign/session change                  | Canceled/rejected; no dial                                          |
| Inbound accepted before stale auto callback               | No outbound now or unexpectedly after inbound                       |
| Ignore/auto next with another queued call                 | Queue rechecked; automatic work still defers                        |
| Acceptance versus timeout/hangup                          | One valid transition; no terminal regression                        |
| Transfer acceptance versus recipient inbound/auto/manual  | One endpoint assignment                                             |
| Old finalization after new reservation                    | New slot remains occupied                                           |
| Lease expiry during uncertain command                     | No automatic slot release                                           |
| Competing workers/reconciliation                          | No duplicate side effect or stale intent execution                  |
| Controlled mixed lock timings                             | No lock inversion; bounded retry without duplicates                 |

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
- Auto next pauses for inbound while an explicit next-lead click follows manual policy.
- Campaign/pause, tabs/session takeover, stale SSE/polling, duplicate requests, autoplay,
  and service INVITE preceding HTTP response.
- Transfer accept/decline/timeout/cancel and control permissions for both directions.
- Administrator number/flow/audio forms, previews, validation, apply errors.
- History, recording playback, and inbound/transfer results.

Use current Playwright infrastructure and deterministic fixtures. Clearly distinguish
fake-media browser checks from actual SIP/RTP validation.

### 13.4. FreeSWITCH, Failure Injection, and Regression

- Ingress, waiting audio, connect timeout, customer CANCEL/hangup, rebridge, old-agent
  late hangup, recording continuity on the pinned image.
- Full/interrupted/failed audio; external busy/no-answer/answer; customer exit during
  dialing; no orphan lines or forwarding loops.
- Failure after claim/before send, after send/before ACK, after bridge/before DB update;
  reconnect/backlog, worker crash, lost execution-lock connection.
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

Separate DB/API/control-plane from realistic SIP/RTP runs; label simulated presence.
Twenty offer recipients must not produce twenty browser media legs for one call.
Real-provider load calls require separate authorization.

Record seed, revision, environment/resources, agent/call concurrency, arrival rate,
duration, recording/media options, and cleanup. Measure offer/admission/connection
latencies including p95/p99, lock/transaction times, DB pool, ESL backlog, CPU/memory,
errors, and post-run slots/legs.

Correctness gates: zero duplicate interactive assignments, duplicate dial/bridge
operations, unrelated offer cancellations, and unexplained orphan legs/reservations
after reconciliation. Define latency/resource budgets before acceptance runs; do not
infer an SLA from an arbitrary result. Save the reproducible load report with handoff.
Do not hide capacity failures behind retries.

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

Add discoverable DB/concurrency and inbound/transfer load commands where current scripts
lack coverage. `test:inbound:db` and `test:load:inbound` are suggested names, **not existing
scripts**. Document fixtures, setup, dependencies, cleanup, and invocation in runbooks.

Integrate unit/contract tests into quality; real PostgreSQL integration/bounded races
into a CI job with PostgreSQL; browser/FS into appropriate jobs. Run heavier load/soak
in a controlled environment before enablement. Record skipped/blocked gates. Old green
commands do not prove new paths are covered.

Provider acceptance separately verifies DID, codecs, two-way audio, caller ID, external
forwarding, hangup, and transfer behavior. Separate local/synthetic from provider and
production evidence. Listed future tests have not run merely because they appear here.

## 14. Enablement, Compatibility, and Rollback

1. Ship additive schema/compatible readers with feature disabled.
2. Migrate all admission/release paths. Legacy requests cannot bypass slots or silently
   dismiss offers; new explicit manual starts use their policy, automatic starts defer.
3. Upgrade API/web; no ingress across versions with conflicting slot protocols.
4. Apply/verify FS configuration; separately verify provider delivery.
5. Complete unit/integration/E2E, controlled load/recovery, and provider acceptance
   before enabling the target route.
6. Before rollback, stop new inbound/transfers and drain new scenarios/unresolved
   operations. Migrations are not reversed automatically.
7. Verify the supported rollback version against new states/participants and historical
   readers. Ship compatibility releases if needed; record the minimum version.

Deployment, restarts, and production changes require separate authorization.

## 15. Handoff to Another Agent Chat

Provide this file and name a phase from section 12. The next agent must:

1. Read current `AGENTS.md`, status, related docs/KB; compare HEAD with the baseline.
2. Separate confirmed requirements, proposed defaults, and schema/API proposals.
3. Obtain an explicit implementation task; this document does not authorize code changes.
4. Record the actual lock graph across all media paths before phase C.
5. Preserve automatic deferral versus atomic manual dismissal as distinct policies.
6. Do not claim race safety without real PostgreSQL tests in section 13.2.
7. Deliver unit/integration tests with each phase and appropriate E2E/FS/load evidence.
8. Record files, commands/results, unverified runtime, next phase, and new constraints.
   Do not silently change requirements.
9. Do not commit/push/deploy without permission; capture verified summaries per project rules.

Open checks: provider DID field/trust boundary; pinned-image rebridge; stopping stale
executors before uncertain slot reuse; old-reader compatibility; existing auto next
after outbound voicemail release; explicit manual-outbound policy for pending transfer
offers. Resolve before affected-path enablement; schema/test planning can proceed.

## 16. Reference Material

- [FreeSWITCH CLI/API: originate, uuid_bridge, uuid_transfer, uuid_park](https://developer.signalwire.com/freeswitch/reference/cli-and-api/).
- [FreeSWITCH channel variables: hangup_after_bridge, park_after_bridge, park_timeout](https://developer.signalwire.com/freeswitch/reference/channel-variables/).
- [FreeSWITCH dialplan applications](https://developer.signalwire.com/freeswitch/dialplan/dptools/).

External docs describe capabilities, not verified behavior of the pinned image.
New routes, fields, states, and mechanisms remain proposals until backed by implementation
artifacts and appropriate checks.
