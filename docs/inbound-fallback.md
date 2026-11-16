# F03 — Queue timeout and no-answer playback

Task: [F03 #31](https://github.com/sptmru/outbound-freeswitch-dialer/issues/31).
Implementation is staged behind an explicitly supplied C03 executor. I05 owns
worker scheduling/bootstrap and enablement; this module starts no daemon and
changes no feature flag. [F04](inbound-forwarding.md) adds reserved external forwarding.

## Admission and saved intent

`advanceInboundFallback(pool, callId)` uses the common admission lock graph.
A queued call can transition only after its original PostgreSQL queue deadline.
An E02 connection-exhausted `fallback` call can proceed after all older commands
and agent legs resolve. Acceptance winning first prevents fallback; fallback
winning first closes pending inbound offers and prevents stale acceptance.
Exact accepted-request replay retains E02's original response, not new send authority.

Migration `042_inbound_fallback.sql` adds one immutable run per call. It retains
the captured ingress route's flow version and absolute flow deadline. Configuration
edits do not replace this version, its audio snapshot or canonical runtime paths.
Live/unresolved runs cannot be deleted; H04 owns drained retention. No old migration
or compatibility marker is changed.

The SQL-only producer commits one fixed C03 operation per step before wake-up.
Unique call/step keys survive repeated timers and worker restart. Only a resolved,
successful step can advance to the next playback. Missing configuration, failed
playback or expired flow selects a fixed terminal hangup.
A `forward_external` action uses the explicit F04 trunk policy and reserved external
leg. Its failure takes the next saved action; a connected conversation does not
enter failure playback. Missing policy or exhausted capacity records a never-sent
failure and takes that same bounded continuation.

## Native execution and evidence

`inboundFallbackExecutor(pool, executor, esl)` exposes `tick(callId)` and a bounded
`reconcile()` scan (eight calls). C03 supplies separate executor seats, per-call
serialization, a single physical command and fixed Job-UUID. Uncertain commands
are inspected and never blindly resent. SQL transactions never span ESL/media work.

Each playback transfers the retained customer UUID to `inbound-fallback`, whose
Lua script validates durable ingress, latches the operation and installs an
absolute step hangup guard. It emits `inbound_fallback_started`, then
`inbound_fallback_completed` only after native playback returns `FILE PLAYED` while
the session is still ready; otherwise it emits failure or terminal customer evidence
establishes interruption. DTMF termination is disabled. The leg parks between steps
under its guard. This is prerecorded playback, not caller-message capture.

The original waiting script reserves a separate bounded guard window only for a
captured configured flow: queue deadline plus flow timeout plus three seconds.
PostgreSQL offer/acceptance deadlines remain unchanged. Calls without a configured
flow retain the queue deadline guard. A missing worker cannot retain a channel
indefinitely. Each subsequent playback guard is bounded by both step and flow time.
The dialplan also accepts the previous command without a guard-window suffix.
Native step deadlines round down to whole seconds, so scheduling never extends
the saved step budget. E02 successful connection still removes the waiting guard.

A successful BACKGROUND_JOB alone does not complete playback. Resolution needs
that exact finished job plus an operation-correlated playback result or exact
customer-leg termination. Missing job evidence retains uncertainty, even after
hangup, because channel absence cannot fence a delayed sender. Lost playback
evidence never authorizes replay; once the channel is terminal, the conservative
result is interruption. Long playback releases the C03 seat between reconciliation
attempts. Terminal cleanup remains D04/C06 and does not release uncertain capacity.

## Verification

```bash
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN=F03 npm run test:inbound:db:isolated
npm run test:fallback:freeswitch
npm run quality
git diff --check
```

The focused PostgreSQL tests use independent sessions and `pg_blocking_pids` for
both acceptance/fallback lock orders, original DB deadlines, rollback and replay.
Synthetic operation/event fixtures are explicitly distinct from native proof.
The FS runner extends the existing disposable D04 runner with full/chained/missing/
interrupted audio, forced step timeout and restart around send/completion; it retains commands, events,
operation identities and decoded RTP plus the complete D04 cleanup regressions.
It uses the real product entrypoint and explicitly injected coordinator, isolated
networking and pinned FreeSWITCH/PostgreSQL images; no application DB or provider.

Actual command results belong in the issue handoff. Browser WebRTC, provider/far-end,
production storage durability, load/soak, hosted CI, deployment/rollback and target
activation remain separate gates. Local tmpfs tests do not establish those gates.
