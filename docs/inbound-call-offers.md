# E01 — FIFO inbound offers and permanent exclusions

Date: 2026-11-16. [E01 #25](https://github.com/sptmru/outbound-freeswitch-dialer/issues/25).
Branch: `feat/e01-fifo-call-offers`. Base: `e6050cc8a9b9d70e5a3e29d4747edd9ac0ef1eac`.

E01 supplies SQL-only dispatch, due expiry, own-offer Ignore and authoritative
snapshots. Offers allocate no recipient slot, participant, operation, browser leg
or capacity reservation. C03/D04 own the already admitted customer waiting path.
E02 owns winner/connection/retry execution, E03/E04 browser controls and service
INVITE handling, F03 the queue deadline continuation, and I05 runtime activation.
The default `server.ts` does not start the dispatcher or the native media runtime.

## Protocol and bounds

`dispatchInboundOffers(pool, agentId)` discovers the recipient's current Desk,
pending offer call and oldest non-excluded admitted queue call. It acquires the
common `withCallAdmission` lock graph, rechecks discovery after lock waits and
retries a changed graph at most three times. Calls use original PostgreSQL
microsecond arrival followed by UUID for stable FIFO order. Exclusions are
filtered before selecting the FIFO head, so an excluded oldest call cannot starve
this recipient's later work. Ring-all repeats this transaction for each eligible
free recipient; the database's one-pending-offer-per-agent index remains the
backstop across workers. An existing pending transfer position is preserved.

Eligibility uses the shared database decision: active user/campaign, availability,
current live Desk/revision, ready recent verified binding, reconciled free slot,
no legacy interactive call or supervisor media session. New offers additionally
require a non-null current Desk authentication version. A stale/unknown binding,
occupied or uncertain slot, pause or wrong campaign cannot receive an offer.
Maintenance takes the normal call-start shared lock and suppresses new offers;
expiry/closure and snapshots remain available.

The offer timeout is the captured route's `configuration.offer_timeout_ms`
(default 15000; integer 5000–30000), capped by the original queue deadline.
Later queue edits, repeated requests and dispatch never extend an existing offer
or the queue budget. Closed offers stay immutable.

`expireInboundOffers` runs under recipient admission locks. Shared
`CallAdmission.eligibility` also applies due expiry before deciding, so a late
timer cannot authorize a stale acceptance or continue vetoing automatic work.
Expiry and its B04 exclusion commit together. A containing transaction's rollback
rolls both back; deadline checks still reject a stale reservation, and the next
dispatch/snapshot applies closure. Rejected Ignore on an overdue offer commits
expiry before returning its conflict.

Ignore closes only the caller's inbound offer as `ignored/user_ignored`; expiry
uses `expired/deadline_elapsed`. Both preserve the customer call and other
recipients, and permanently exclude `(call_id, agent_id)` across Desk, campaign,
attempt and safe requeue changes. `canceled/winner_accepted` and ordinary
eligibility cancellation create no exclusion. The failed-connection requeue
boundary in E01 tests is a seeded E02 state, without media or cleanup proof.

After closure, the next dispatch can select the next non-excluded FIFO call.
Existing C05 callbacks reevaluate the same deferred auto intent against the
remaining queue. E01 does not fabricate an auto-next source or a manual fallback.

`startInboundOfferDispatcher(pool, report)` is an explicit runtime-owner entry
point: 250 ms ticks, no overlapping ticks, a stable round-robin agent UUID cursor,
at most 20 recipient transactions per tick and one pooled connection at a time.
Polling retries becoming-free recipients and covers lost refresh events and late
timers. The owner must stop it before closing its pool. I03 must measure target
latency/resource budgets; these bounds are not load/soak acceptance evidence.

## API, replay and refresh

- `GET /agent/call-offers?deskSessionId=<uuid>` returns `CallOffersResponse`:
  `{revision, offer: CallOfferSnapshot | null}`. It authenticates the current
  controller, expires due work and cancels invalid pending work. It never creates
  an offer or reserves a slot. Responses use `Cache-Control: no-store`.
- `POST /agent/call-offers/:offerId/ignore` uses the existing strict
  `DeskMutationRequest` (`deskSessionId`, `expectedRevision`, `bindingGeneration`,
  `idempotencyKey`). The server derives the recipient from the authenticated user,
  rechecks user/auth version and the controller under admission, and rejects
  foreign offers, stale identities and injected actor fields. Cookie mutations
  use the existing Origin/CSRF protection.
- Success returns `{status: "applied", revision}`. Migration
  `037_inbound_offer_dispatch.sql` stores actor-scoped key, offer, fingerprint
  and original revision in `call_offer_mutations`. Exact replay returns that result
  without touching a later offer, including after Desk replacement. Reusing a key
  with another payload/offer conflicts. Terminal offers return `offer_closed` or
  `offer_expired`; they never reopen. Transfer decline is G01 work.
- PostgreSQL row notifications for offers, exclusions and changed auto intents
  flow through the existing `live-events.ts` listener to `GET /agent/events`.
  Notifications contain table-name refresh hints and publish only on commit.
  No-op polling or unchanged auto-intent updates emit no hint. Clients refetch
  the snapshot; SSE replay is never a mutation or acceptance authority.

The migration is additive and does not change feature flags or prior migration
checksums. H04 must delete `call_offer_mutations` before related retained offer
history during eventual drained retention; the foreign key prevents accidental
loss of replay identity. Old code remains compatible while native work is disabled.

## Verification

`apps/api/src/inbound-offer-policy.test.ts` covers the eligibility rejection matrix,
current-versus-legacy authentication snapshots and captured timeout bounds.
`apps/api/src/inbound-dispatcher.integration.test.ts` is part of
`npm run test:inbound:db` and the isolated PostgreSQL runner. It covers:

| Criterion | Required local evidence                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E01.1     | Twenty recipients; unavailable-recipient matrix; no added slot, leg, operation, participant, capacity or contact attempt; repeated dispatch deduplication; snapshot timeout versus later edits.                                            |
| E01.2     | Own-only Ignore, durable HTTP replay, changed-key conflict, other recipients preserved; winner cancellation and seeded safe requeue; session/campaign changes retain exclusion.                                                            |
| E01.3     | Already-overdue offers without a running timer; snapshot/admission closure; stale reservation rejection and immutable history; real separate PostgreSQL backends with `pg_blocking_pids`, both claim/dispatch orders and leading rollback. |
| E01.4     | Microsecond FIFO/UUID ties; becoming free; next eligible work after closure; no reoffer after all calls excluded; original queue deadline; same C05 deferred intent rechecked without a new contact claim.                                 |

Additional checks exercise real authenticated HTTP/CSRF, transactional notification
delivery through `live-events.ts`, absent hints after rollback, and a populated
036→037 migration/replay preserving earlier history/settings/checksums. The C01
regression now asserts automatic persisted expiry instead of rewriting a closed
row. Tests use actual PostgreSQL with synthetic calls/Desk/contact evidence and
no ESL sender. The acceptance claimant is a SQL admission/reservation fixture;
the E02 HTTP acceptance and connected media path remain separate.

Final local verification (Node.js `v23.7.0`, required >=22):

| Command                                                            | Result / artifacts                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`        | **PASS 117/117**, zero skipped; pinned PostgreSQL 17.11, network `none`, no published ports, bounded tmpfs. `/tmp/outbound-inbound-db.XkwkWbUx/` retains `result.txt`, source hashes, image/isolation metadata and container cleanup record.                                                                                                                                                                                                 |
| `INBOUND_PG_STORAGE=tmpfs bash /tmp/e01-test-focused.sh`           | **PASS 22/22**, zero skipped: 17 E01 DB/API groups plus five C01 groups. `/tmp/outbound-inbound-db.AHjiLFls/`. The temporary wrapper uses the same isolated runner with those two compiled test files.                                                                                                                                                                                                                                       |
| `npm run quality`                                                  | **PASS** OpenAPI, lint, format, types, tests and builds. API: 300 passed, 116 database-dependent checks skipped because `TEST_DATABASE_URL` is absent; the dedicated 117-test DB gate above ran separately without skips. Web: 152/152; ops: 78/78. `/tmp/e01-quality-final.log`. Initial sandbox execution failed on existing loopback tests with `listen EPERM 127.0.0.1`; the successful rerun had permission to bind local test sockets. |
| `npm run test:voicemail:db`                                        | **PASS 8/8**, zero skipped, separate disposable PostgreSQL 16 fixture; `/tmp/e01-voicemail-final.log`.                                                                                                                                                                                                                                                                                                                                       |
| `sha256sum -c /tmp/outbound-inbound-db.XkwkWbUx/source-sha256.txt` | **PASS**, the final implementation matches the real DB run.                                                                                                                                                                                                                                                                                                                                                                                  |
| `git diff --check`, `bash -n scripts/test-inbound-db.sh`           | **PASS**.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

All disposable containers were removed. Changes remain local and uncommitted on
`feat/e01-fifo-call-offers`; no push, PR or deployment was performed.
No browser/WebRTC, FreeSWITCH/RTP, provider, hosted CI, target-storage, load/soak,
deployment, rollback-version or production acceptance is supplied by E01.
