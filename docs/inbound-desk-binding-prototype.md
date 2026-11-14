# A04 — Controlling Desk to SIP Endpoint Binding

Date: 2026-11-14. [A04 #5](https://github.com/sptmru/outbound-freeswitch-dialer/issues/5),
[tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Branch: `prototype/a04-desk-sip-binding`.
Base: `773e65245470eb93db534ddc6c57257d57fdc2ba`.

This is an isolated FS + PostgreSQL decision prototype. Product routes, migrations,
SIP.js, provisioning, admission and deployment remain separate B02/D01/E04 work.
The fixture uses real authenticated UDP SIP registrations and FS-generated RTP;
Desk/heartbeat/acceptance controls are simulated against an isolated DB. It does
not establish browser WebRTC, a full inbound/outbound/transfer conversation, provider
acceptance, or permission to enable product routing.

## Selection and source review

The working tree was clean. Read AGENTS.md and searched the Developer Knowledge
Base with the task/repository wording, `desk_session_id` and similar SIP incidents.
Fetched the full current GitHub backlog and tracker. A01–A03 were closed as completed;
A04 is the first remaining task by ID and depends only on A01, in both its dependency
statement and links. A04 had no assignee or comments at the immediate recheck.
The GitHub connector returned no open PRs; read-only REST subsequently confirmed
an empty open-PR list and only issue cross-references in A04's timeline. The connector
does not expose timeline, so that check used `gh api`. Posted the start comment before
creating the local branch. No unrelated local changes existed.

Reviewed the [source plan §9.1](inbound-calling-implementation-plan.md#91-controlling-desk-session-and-sip-endpoint),
[requirements](requirements.md), [architecture](architecture.md),
[implementation status](implementation-plan.md), [environment contract](environment-configuration.md),
[ADR 0001](adr/0001-initial-architecture.md), and A01/A02/A03 artifacts.
Current product code still routes to `user/<sipUsername>@<domain>` in
`apps/api/src/esl.ts`, reconciles agent-level registration flags in
`apps/api/src/agent-registrations.ts`, and writes agent directory entries in
`apps/api/src/freeswitch/provisioning.ts`. This prototype does not change those paths.

## Selected binding protocol

Choose **a separate server-issued SIP identity and secret for each Desk generation**.
Associate every identity with one authenticated agent, Desk session and monotonic
generation. Never share the agent's existing SIP password between Desk sessions.
The prototype's two identities both belong to fixture agent `1`.

1. Provision a new random username/192-bit password through a server-controlled
   directory. The prototype rewrites its isolated XML and executes `reloadxml`.
   Product D01 must deliver credentials only to the owning authenticated session,
   preserve encryption at rest, authenticate HTTP actions and reconcile failed
   provisioning. Never take a destination string or password from a browser as
   authoritative routing evidence.
2. Under the agent row lock, allow takeover only with `slot='idle'`. Increment the
   generation, replace controller authority, revoke the old identity in durable state
   and clear readiness/endpoint. Establishing authority does not itself establish readiness.
   The same transaction must invalidate old offers/auto intents in the product;
   those entities do not exist in this prototype and remain D01/C05/E01 work.
3. Verify the new identity using native
   `sofia_contact a04-loopback/<username>@a04.invalid`. Only one exact contact from
   that trusted lookup is usable. The fixture admits only its own profile, generated
   username and literal loopback addresses/ports. Missing/error/multiple contacts,
   ESL failure and malformed/forked dial strings clear readiness. Never fall back to
   `user/<agent>` or choose the newest of several contacts.
4. Publish readiness through a conditional update matching session, generation,
   username and unexpired lease. Lookup occurs outside the DB lock; the conditional
   update fences delayed old verification. A REGISTER `200` is only authentication
   acknowledgement: lookup visibility can lag, so the fixture waits at most five
   seconds for authoritative verification, remaining unavailable meanwhile. It does
   not re-register or retry originate to hide a failed lookup.
5. Pin the verified contact to that generation. If a reconnect moves Contact, mark
   unavailable; a new idle generation is required to bind a different endpoint.
   An occupied slot cannot be moved by reconnect or expiry. The product's endpoint
   reconciler must apply the same fail-closed policy continuously and immediately
   before reserving/sending; a cached registration flag is insufficient.
6. Claim `reserved` with the exact controller generation, readiness, unexpired lease
   and idle slot. Record an operation UUID before ESL. Send directly to that verified
   endpoint, including session/generation/operation correlation. The three fixture
   service shapes share this primitive and differ by a diagnostic shape header;
   they do not implement the later product call flows or agent-to-agent rebridge.
7. Reject a service INVITE whose session/generation/operation no longer matches.
   The fixture consults PostgreSQL to simulate the receiving Desk's authorized
   snapshot; product SIP.js must use its authenticated operation/session contract.
   An already queued old command can still reach the old endpoint: it is rejected
   with `480` and never becomes an accepted conversation. PostgreSQL generation
   checks do not physically fence an already in-flight ESL command; A05/C03 own that
   executor uncertainty boundary. The normal newly authorized sends target only
   the current endpoint.
8. Scope every heartbeat/close/registration teardown to its identity and generation.
   Stale heartbeat and close update zero controller rows. A close clears readiness;
   it does not release an occupied slot. Expired heartbeats stop new eligibility
   but never kill an existing media leg or free reserved/connecting/active/releasing/
   uncertain state. Ordinary takeover is rejected in all five states.

### Revocation and bounded cleanup

The lab records `revoked` and `cleanup_due=takeover+5 seconds` in the same transaction.
Within that bound it removes only the obsolete directory user, reloads XML, executes
`sofia profile a04-loopback flush_inbound_reg <obsolete-user>@a04.invalid`, verifies
absence and confirms that an old authenticated refresh is refused. It performs this
while the new media leg is live and asserts continuing RTP and the same UUID.
It never flushes the whole profile or current agent/controller.

Five seconds is a healthy-local-FS fixture budget, not a production guarantee during
an FS outage. The product requires a durable retrying cleanup worker, retained failure
state/alerts, bounded batch size and A06-approved deadlines. Failures must not publish
readiness or release occupied/uncertain claims. Session revocation remains effective
for authorized actions even while physical registration cleanup is pending.
After the scenario matrix, the lab also revokes its current identity, verifies no
remaining registrations and removes all three disposable containers/PG volume.

The alternative, one shared SIP identity plus contact selection, was rejected for
this implementation: old refresh/unregister and copied credentials share too much
authority. Per-generation identities make credential revocation and teardown scoped.
Contact-specific routing is still required after verification so an ambiguous
same-identity registration cannot silently fork or redirect an INVITE.

## Reproduction and evidence

```bash
node tests/a04-binding.test.mjs
bash -n scripts/test-a04-binding.sh
npm run test:prototype:desk-binding
npm run quality
git diff --check
```

The Linux runner requires Node.js >=22, local Docker, `nsenter`, `timeout`, and the
two already available images. It never reads `.env`, `DATABASE_URL` or
`TEST_DATABASE_URL`. It creates a `--network none` namespace anchor; FS and PG join
only that namespace, with no published ports. PG listens only on its disposable Unix
socket. The FS profile is loopback-only with authenticated registration and deny-all
client dialplan. The probe has a 180-second wall-clock bound, 1-second DB acquisition,
5-second DB lock, 10-second DB query and 3-second originate bounds. FS permits eight
channels and 50 fixture sessions/second. These are local harness values for A06 review.

- FS: `safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6`
- PG: `postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`

Each run prints its private `/tmp/outbound-a04.*` directory, retained on failure too.
It contains `report.json` (registration status ledger, actual INVITE destinations,
operation UUIDs, sanitized ESL chronology, command responses, persisted DB snapshots,
RTP counts and cleanup), image/revision/source hashes, isolation and container logs.
Fixture credential/XML/registrar files are private lab material; do not publish them.
No provider traffic or production service is accessed.

| Criterion     | Runtime assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A04.1 FS      | Two real Digest-registered SIP clients for one fixture agent; refresh A/B then B/A; six accepted service INVITEs across inbound/outbound/transfer shapes reach only A; after takeover B receives its service leg; inspect actual receiving socket, correlation and incremental RTP, not an ESL job acknowledgement.                                                                                                                                                                                                                        |
| A04.2 FS + DB | Separate PG connections and explicit barriers: reservation commits first and waiting takeover rolls back after revalidation; takeover commits first and waiting old reservation fails. Pause old verifier after real FS lookup, commit takeover, then resume: it updates zero rows. Pending B is unavailable until verified; old heartbeat/close/unregister cannot affect B. Delayed old INVITE is rejected. Multiple contacts and a sole moved Contact both block readiness. Cleanup revokes old credentials while B's UUID/RTP survives. |
| A04.3 DB + FS | For each of three service shapes, inject all five persisted occupied slot states, expire heartbeat, reject takeover and assert unchanged generation/slot, the same live UUID and increasing RTP: 15 checks. Refused takeover persists no identity and releases no reservation. Final media cleanup converges to zero channels; slot is idle with no operation; final registration teardown is verified before containers are removed.                                                                                                      |

The independent unit suite has four tests covering unsafe/ambiguous routing, failed
lookup fencing, stale service correlation and Digest/parser failures. It supplies U
evidence only. DB barriers use real locks and inspect `pg_stat_activity` lock waits;
there are no arbitrary sleeps deciding commit order. Occupied states are explicit
prototype fixtures around a real media leg, not implemented product lifecycle transitions.

Recorded run and regression results are published in the A04 issue handoff. Only a
passing run of the final source revision is acceptance evidence. Earlier failed
fixture runs are retained separately and do not count as completed criteria.

### Verified run — 2026-11-14

Final FS + DB run: `2026-11-14T08:57:44.635Z` (12:57 Asia/Yerevan), Node `v23.7.0`,
FreeSWITCH `1.10.12`, the pinned images above, fixed fixture agent/session/shape matrix,
random disposable usernames/UUIDs recorded in the artifact. Six scenario groups
passed, covering A04.1–A04.3, both DB commit orders and all 15 occupied-state checks.
Ten INVITEs were accepted at the intended endpoints; one stale INVITE was refused;
the duplicate-registration client received none. Old identity cleanup took 89 ms and
finished before `takeover+5s`; authenticated refresh then returned `403`. Final state:
zero channels, zero registrations, idle slot, null operation and readiness false.

Artifact: `/tmp/outbound-a04.1mhqhEOy/report.json`.
SHA-256: `1a87d4676cd513a399116fdd4968830b82793a00594cc95c0a076af3f88345ee`.
The same directory records base revision, source hashes and namespace/image evidence.

| Command                               | Result                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `node tests/a04-binding.test.mjs`     | Four tests passed.                                                                                                               |
| `bash -n scripts/test-a04-binding.sh` | Passed.                                                                                                                          |
| `npm run test:prototype:desk-binding` | Passed, six groups; actual isolated FS + PG, UDP SIP/RTP.                                                                        |
| `npm run quality`                     | Passed: API 262, web 134, ops 57; OpenAPI/lint/format/typecheck/build passed. Log: `/tmp/outbound-a04-quality-unrestricted.log`. |
| `git diff --check`                    | Passed.                                                                                                                          |

The first sandboxed quality invocation failed with `listen EPERM: operation not permitted
127.0.0.1` in existing ESL/registration fixture servers. Direct focused runs confirmed
that restriction; the final full gate ran with loopback listeners permitted and passed.
`TEST_DATABASE_URL` was unset: optional application DB integration suites did not run.
The separate A04 runner supplied its own real disposable PG and did run the A04 DB
barriers. General E2E, the full FS regression matrix, load/soak and provider suites were
not run; this protocol prototype does not claim their acceptance.

## Remaining implementation and acceptance boundaries

- B02/D01 must integrate identities, leases, slot fencing, auth, durable provisioning/
  cleanup, offers/auto-intent invalidation, registration reconciliation and restart recovery.
- E04 must implement authenticated browser service-INVITE correlation and explicit
  acceptance. I02.3 must exercise actual SIP.js/WSS/WebRTC, two tabs and real browser RTP.
- A05/C03/G02 must prove stale executor handling and real customer-preserving rebridge.
- A06 supplies production registration lifetimes, cleanup/resource/timeout budgets.
- I04/I05 retain provider, target rollout and enablement gates. None is implied by
  the local A04 endpoint-selection and takeover evidence.
