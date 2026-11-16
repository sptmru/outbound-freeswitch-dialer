# F04 — Reserved external forwarding

Task: [F04 #32](https://github.com/sptmru/outbound-freeswitch-dialer/issues/32).
This extends the staged [F03 worker](inbound-fallback.md); I05 still owns scheduler
bootstrap, deployment and activation. No feature flag or production route is enabled.

## Intent and capacity

`inboundFallbackExecutor(pool, executor, esl, forwarding)` accepts an explicit
trunk policy using the existing `SIP_TRUNK_MODE`, `SIP_TRUNK_PROXY`,
`SIP_TRUNK_USERNAME` and `SIP_TRUNK_CALLER_ID` configuration. The caller ID is a
fixed configured identity, normalized with the existing strict phone validator;
original caller identity is never copied. Provider approval of that identity and
From/PAI behavior remains I04. The target is the immutable F01 flow version's
normalized destination, with its original timeout and finite failure continuation.
The command snapshots the dial string and caller ID before execution; changing
worker configuration cannot change a pending operation's destination.

Under common admission, the producer saves one external participation, concrete
UUID, leg and C03 operation, then claims `customer_channel`, `trunk_call` and
`external_forward` together. Any capacity failure rolls back the entire bundle
and records a failed, never-sent step. The next tick selects the next saved action;
F01 permits at most one forward, so exhaustion cannot recursively dial. Missing
trunk/caller policy also takes this bounded continuation without creating a leg.
An unresolved operation is returned unchanged on replay. The command driver
revalidates all three retained permits before sending.

## Native execution and cleanup

C03 sends one fixed-job `uuid_transfer` into `inbound-forward`. The repo-owned
Lua bridge reuses the retained customer, fixes `origination_uuid`, sets a bounded
answer timeout and owns cancellation when the customer leaves. Answer cancels
the waiting guard; a connected conversation is not cut off by the no-answer
flow deadline. Failure parks the retained customer for the saved continuation.
A successful conversation ends when either endpoint ends it, without playing
failure audio afterward. Exact native bridge evidence marks the external
participation connected; terminal call history distinguishes a completed forward
from customer exit during dialing.

The transfer job can finish before Lua originates. Therefore neither its ACK nor
customer/channel absence resolves the operation alone. Resolution requires the
fixed completed job plus `outbound_dialer::inbound_forward_finished`, emitted with
operation/call/external UUID even after customer hangup, followed by exact external
cleanup. A negative transfer result can prove Lua was never started. Only after
that producer fence may an absence probe close a leg whose terminal event was
lost or which never existed. Missing completion evidence retains uncertainty and
capacity; H01 owns wider restart/reconciliation. There is no blind retry.

Provably unstarted canceled operations close their synthetic pending participation
without a media action. Existing C06 cleanup releases resources only after all
possible senders resolve and concrete cleanup is confirmed. The worker releases
its C03 connection while waiting for the native conversation and reconciles in
bounded batches, rather than holding a DB connection for the conversation.

## Verification

```bash
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN=F04 npm run test:inbound:db:isolated
npm run test:forwarding:freeswitch
npm run test:fallback:freeswitch
npm run quality
npm run test:voicemail:db
git diff --check
```

The F04 DB tests use PostgreSQL sessions and `pg_blocking_pids` for the capacity
race, rollback/replay and terminal/late-answer permutations. The native runner
extends D04 with isolated UDP SIP/RTP endpoints, configured caller identity,
answer/busy/rejection/no-answer, customer exit and delayed answer, worker replay
and a TCP relay that drops the command response. It checks decoded tones in both
directions, one logical external dial, saved failure playback and final resource
and channel cleanup. These are local FS checks, not provider/browser acceptance.

Exact results and artifacts are recorded in the issue handoff. Tmpfs database
checks do not establish target-storage durability. Provider policy/far-end audio,
browser WebRTC, full recovery/load/soak, hosted CI, deployment and rollback remain
separate I01–I05 gates.
