# G01 — Transfer offers and admission

Date: 2026-11-17. Issue [G01 #34](https://github.com/sptmru/outbound-freeswitch-dialer/issues/34).
Branch: `feat/g01-transfer-offers`. Base: `88ca479`.

G01 implements SQL-only transfer proposals, recipient acceptance reservations,
decline, source cancel and deadline expiry for native inbound/outbound calls.
The source stays the owner until G02 confirms the new bridge. G02 owns physical
originate/rebridge, connection recovery and cleanup; I05 owns runtime activation.
No provider or production behavior is established here.

## Protocol

- `GET /agent/calls/:callId/transfer-targets?deskSessionId=...` returns
  `TransferTargetsResponse`. It checks source ownership and returns up to 100
  agents in stable ID order. Availability is a hint; it reserves nothing.
- `POST /agent/calls/:callId/transfers` accepts `CreateTransferRequest` and returns
  `CreateTransferResponse`: `status: applied`, source Desk `revision`, immutable
  `transfer` snapshot and recipient `offerId`. Recipients may select a different
  campaign; the product call retains its campaign. Outbound transfer offers show
  the customer destination, while inbound offers show the original caller.
- `DELETE /agent/calls/:callId/transfers/:transferId` accepts `DeskMutationRequest`
  and cancels only the initiating owner's still-offered attempt. An accepted
  reservation cannot be canceled through this offer-only endpoint.
- `POST /agent/call-offers/:offerId/ignore` declines a transfer as
  `declined/user_declined`. Source cancel uses `canceled/source_canceled`.
  Due expiry uses `expired/deadline_elapsed`; terminal sources use
  `canceled/call_closed`. Both transfer and offer receive the same closure.
- `GET /agent/call-offers` includes transfer offers. The existing bounded
  dispatcher processes their expiry and eligibility cancellation. Neither expiry
  nor closure reoffers a transfer automatically or creates an inbound exclusion.

Mutations authenticate the current user/auth version and controlling Desk.
Discovery includes both agents, selected campaigns and pending source calls;
`withCallAdmission` locks the full discovered ownership/participation/transfer graph.
Changes during lock waits roll back and rediscover, at most three times.
Deadlines and current eligibility use PostgreSQL time. The source must have an
active fenced slot, native connected participation, live concrete source/customer
legs and a `bridged` or `agent_connected` call. An answered customer alone is
insufficient. Pending offers reserve no recipient slot, leg, operation or capacity.
Existing recipient inbound/transfer offers are never silently replaced.

The offer deadline is the bounded 20-second policy. It does not reset on replay.
Acceptance reserves exactly one recipient slot, creates an unconnected participant
and fixed leg UUID, and persists a C03 `rebridge` intent with a separate 10-second
connection budget. Browser-channel and transfer-overlap capacity commit atomically.
The request records `transferOfferAcceptance`, `transferId`, `agentUuid`, `slot`,
verified endpoint/controller identity, source participant/UUID/slot, customer UUID
and the original response. Source ownership, slot and connected participation
remain unchanged. A failed transaction rolls back every recipient effect.

`transfer_offer_mutations` (migration 043) retains actor/key/fingerprint and response.
Same key/payload returns its committed result; a changed payload conflicts.
Another key for an accepted offer returns the same operation after checking Desk
identity. Closed attempts never reopen. Replay records cannot change and cannot
be deleted while their call/transfer/operations remain live or unresolved.
Retention integration remains H04; this migration deliberately refuses early deletion.

## Execution boundary

`registerCallOfferRoutes` takes a separate optional `transferConnection` adapter.
A transfer accept without it returns `coordination_unavailable` before reservation.
The default dashboard/server bootstrap supplies no transfer executor. G02 must
consume the immutable acceptance intent, validate the source/recipient again,
authorize media against the connection deadline, execute through C03, confirm
bridge before handover, and reconcile exact cleanup before releasing either slot.
The inbound executor cannot accidentally consume a transfer intent.

C04's actual manual routes already atomically decline pending transfers only on
successful outbound admission. G01 tests now race those HTTP endpoints with the
real transfer producer in independent Node/PostgreSQL processes. Acceptance wins
by reservation; manual admission wins by atomically declining only its pending
transfer. Automatic starts defer to a pending transfer and cancel after acceptance.
A delayed inbound action cannot bypass the one-pending-offer constraint or claim
an already reserved recipient.

## Verification

`apps/api/src/transfer-offers.integration.test.ts` runs under the required
`test:inbound:db` entry point. It verifies both directions, cross-campaign targeting,
auth/ownership, stale availability, occupied/unverified recipients, pre-existing
inbound offers, duplicate requests, immutable replay, closure outcomes and no
reoffer. Its controlled process schedules use `pg_blocking_pids`, both commit
orders and rollback against all three manual HTTP routes, automatic starts,
stale inbound acceptance and source cancel. It inspects persisted source state,
recipient slots/participants, operations, capacity, contact attempts and zero sends.
Capacity exhaustion rolls back the entire recipient reservation.

```bash
INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated
npm run test:transfers:offers:freeswitch
npm run quality
git diff --check
```

The FS command extends the isolated E02 product-entrypoint lab, using pinned
FreeSWITCH/PostgreSQL and local UDP SIP/RTP. While a real source conversation is
connected, G01 creates and declines/cancels/expires actual product offers. Each
case checks the same bridge UUID, owner, slot, participation, fresh decoded
customer-to-agent audio and zero additional durable commands. E02 also decodes
the reverse audio at the customer and requires terminal cleanup/zero channels.
The recipient's readiness is an explicit SQL fixture; there is no recipient
originate or completed transfer in this G01 lab. Browser/provider/WebRTC, G02
switching/recovery, target storage/load, hosted CI and I01–I05 remain separate gates.

The complete required DB runner has an eight-minute subprocess watchdog and
its disposable shell runner a ten-minute watchdog, accommodating the expanded
serial product/race matrix. These are suite bounds; admission, lock, ESL and
per-scenario budgets remain unchanged.

Verification results and retained artifact paths are recorded below after execution.

## Local verification record

Node.js 22.13.0; pinned PostgreSQL 17.11 on bounded disposable tmpfs; pinned
FreeSWITCH 1.10.12. No application database, provider, production service or
published port was used. All changes remain local and uncommitted at base
`88ca479a9e968330e657119ed0179a8aecbab312`.

| Gate                                                 | Result and artifacts                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full `npm run quality` with real `TEST_DATABASE_URL` | **PASS:** 495 API tests, zero skips; 183 web tests; 78 ops tests; OpenAPI, lint, formatting, typecheck and all builds. Disposable wrapper: `INBOUND_PG_STORAGE=tmpfs bash /tmp/g01-final-quality.sh`, with Node 22 and `/tmp/f02-ffmpeg` on PATH. `/tmp/outbound-inbound-db.bhkF4eVn/result.txt` contains the complete gate, source/image/isolation metadata, per-scenario G01 reports and successful container removal. The recorded source hashes matched the final implementation. |
| G01.1                                                | **PASS DB/API:** inbound/outbound, cross-campaign recipients, correct customer number, ownership/authentication, stale hint, existing inbound offer, occupied/unverified recipient, single unfinished attempt and replay/conflict.                                                                                                                                                                                                                                                    |
| G01.2                                                | **PASS DB/API/FS:** distinct decline/cancel/expiry/terminal outcomes, unchanged live source state and no reoffer. Both cancel/accept and terminal/accept process orders pass; accepted reservations remain retained. The real E02 source bridge and fresh decoded RTP survive all three offer closures.                                                                                                                                                                               |
| G01.3                                                | **PASS DB/API:** all three real manual routes versus actual G01 acceptance, both commit orders and rollback, duplicate request replay, failed validation/contact claim, already-closed source, accepted-reservation fencing and complete capacity-rejection rollback. HTTP capacity errors use contract code `capacity_exhausted` and retain internal message `capacity_exceeded`.                                                                                                    |
| G01.4                                                | **PASS DB:** separate Node/PostgreSQL workers, observed `pg_blocking_pids`, inbound-offer exclusivity/stale acceptance and automatic/manual competition; one recipient reservation/intent, exact source preserved, no second originate or physical send.                                                                                                                                                                                                                              |
| `npm run test:transfers:offers:freeswitch`           | **PASS 10/10 groups:** three G01 continuity cases plus seven E02 media/fault/regression groups, including decoded reverse audio, lost response and late-answer cleanup. `/tmp/outbound-e02.T7hRNI0U/report.json`, source hashes, signaling/container logs and cleanup records. Final actual FS channel count, unresolved operations, occupied slots and retained capacity are zero. Read-only ESL inspection is separate from the zero additional G01 media commands.                 |
| `npm run test:voicemail:db`                          | **PASS 8/8**, zero skips, disposable PostgreSQL; `/tmp/g01-voicemail-final.log`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Patch hygiene                                        | `git diff --check` passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Earlier attempts are retained, not counted as passing gates. Initial fixture and
expectation errors were corrected. The old 300-second strict DB watchdog stopped
after 159 passing checks (`/tmp/outbound-inbound-db.B1mmmXHO`); a later attempt
exposed an E01 notification test timeout (`/tmp/outbound-inbound-db.XFNrLsGd`).
Its extra listener was released only on success, masking failures in pool cleanup;
cleanup is now unconditional and the notification fence has a diagnostic watchdog.
The triggering notification/host timing failure was not reproduced or attributed
to a product root cause. E01 passes in both the focused diagnostic and final full
DB-backed quality gate. `/tmp/outbound-inbound-db.SD8juOqX` records the diagnostic
run, including a subsequently corrected capacity assertion expectation. An initial
FS run (`/tmp/outbound-e02.JH8hGKwV`) observed one channel immediately after terminal
persistence; the final gate requires bounded actual removal, with no cleanup kill.
One quality attempt failed before tests on a transient ESLint `.aws` ENOENT
(`/tmp/outbound-inbound-db.BEyX29cO`); the final run passes the same lint command.

The whole strict DB command was not subsequently reported as passed; the final
DB-backed quality gate runs every API test, including all strict-runner suites and
all eleven G01 test groups, with zero skips. Browser tests in quality are component
checks. Integrated WebRTC/provider calls, G02 switching/recovery, target storage/load,
hosted CI, enablement/drain/rollback and production acceptance were not executed.
