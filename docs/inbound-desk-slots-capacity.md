# B02 — Desk sessions, fenced slots and capacity schema

Task: [B02 #10](https://github.com/sptmru/outbound-freeswitch-dialer/issues/10).
Base: `4c8987b19f62d9811c68bf332ee208606c5bc92d` (`dev`).
Branch: `feat/b02-desk-slots-capacity`.

Migration `026_desk_slots_capacity.sql` is an additive, feature-off foundation
using the A04 identity and A06 resource model. Existing calls, agent availability,
pause and `calls_one_active_per_agent_idx` are preserved. C01–C07/D01–D04 still
own runtime admission, SIP provisioning, media discovery and resource enforcement.

## Persistence contracts

| Entity                       | Contract                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_desk_sessions`        | Generated session UUID, agent/campaign, positive revision/binding generation, unique generation-specific SIP identity, optional encrypted secret, expiry and verified endpoint/generation/time. One non-revoked controller per agent, including expired controllers; unique historical `(agent_id,binding_generation)`. Readiness requires verification and no revocation. No credentials/controllers are seeded. |
| `agent_call_slots`           | One row per agent. States `free`, `reserved`, `connecting`, `active`, `releasing`, `uncertain`. Occupied rows require reservation UUID; normal occupied rows also require call. A `free -> reserved` transition advances bigint generation in a trigger; other updates cannot reset generation or replace occupied call/reservation ownership.                                                                    |
| `call_capacity_reservations` | Generated UUID, stable operation UUID, call and optional agent/leg/supervisor, positive units/generation, type/scope and lifecycle. Unique `(operation_id,resource_type,scope_id)` includes released rows. Ownership/units are immutable. Composite leg/supervisor FKs enforce the same call, including parent edits.                                                                                             |
| `call_admission_migration`   | Singleton baseline timestamp and `reconciliation_required=true`. An evidence marker, not a working enable switch. C01/I05 must implement the guarded gate.                                                                                                                                                                                                                                                        |

Generations remain strings in TypeScript to preserve PostgreSQL bigint values.
Operation UUIDs are not FK-linked until B04 creates `call_operations`; nullable
participant UUIDs await B03's `call_participants`. Those tasks must validate/link
existing rows. Backfill does not fabricate completed operations or participants.

Resource types are `queue_waiting`, `customer_channel`, `browser_channel`,
`supervisor_channel`, `transfer_overlap`, `trunk_call`, `external_forward`.
Scope is `deployment` for media/overlap/forwarding, queue UUID string for waiting,
and a configured trunk key (`default` for legacy backfill) for trunk calls. Units
count permits, concrete channels or trunk/forwarding calls as specified by
[A06](inbound-resource-budgets.md). All future writers must use consistent keys.

States `reserved`, `in_use`, `releasing`, `uncertain` consume units:

```sql
select resource_type, scope_id, sum(units) as used
from call_capacity_reservations
where state <> 'released'
group by resource_type, scope_id;
```

`released` requires `released_at`; other states forbid it. Released claims cannot
be reopened/repurposed. C02/C03 still own atomic budget checks, media evidence and
confirmed release. H04 must implement guarded claim retention before deleting
referenced calls, legs, supervisors or occupied agents; those deletions fail closed.
An agent with only an unclaimed initialization slot can still be deleted by legacy
code: the slot cascades away. A row-locking deletion guard preserves real occupied
slots, including transfer recipients who are not `calls.agent_id`.

## Slot operations and evidence boundary

`apps/api/src/agent-call-slots.ts` supplies internal transaction-client primitives:

- `reserveAgentCallSlot`: update a reconciled free slot, issue a random reservation,
  return the full token with the database-generated next generation.
- `updateAgentCallSlot`: match `(agent_id,call_id,reservation_id,generation)` and
  refuse unreconciled/free rows. Stale updates are no-ops.
- `releaseAgentCallSlot`: require the full token and `cleanupConfirmed=true`, clear
  ownership and retain generation. False cleanup evidence returns without DB access.

Callers must hold the future admission transaction and check eligibility,
controller, participant, operation and capacity. These helpers are not public
routes and are not called by today's legacy start/finalization paths. The cleanup
flag is a caller assertion of resolved commands plus confirmed media cleanup;
it performs no FS query and cannot be derived from lease expiry or HTTP/ESL ACK.
Privileged direct SQL is not an API authorization boundary. No time-based release
or ordinary occupied takeover is implemented.

## Upgrade and reconciliation before enablement

Migration 026 locks `agents`, `calls`, `call_legs`, `call_supervisor_sessions` in
`SHARE ROW EXCLUSIVE` mode for one transaction snapshot, without external I/O.
Large tables can extend this window; target migration needs the existing drain
and maintenance procedure. It conservatively captures legacy ownership:

1. Every agent receives an uncertain reservation with `reconciliation_required`.
   The latest interactive-call or unresolved-agent-leg candidate is pinned when
   present. Even apparently idle agents are not declared free without media/command
   reconciliation. An INSERT trigger initializes new agents as uncertain too.
2. Every unfinished call and terminal call with residual nonterminal UUID-bearing
   legs receives uncertain customer-channel/trunk claims. Customer units are at
   least one or all unfinished known customer legs when larger, covering pre-send
   intent and deliberately overcounting ambiguous data.
3. Interactive intent/residual browser legs receive a browser-channel claim,
   counting at least one or all unfinished agent legs. Released voicemail without
   residual browser evidence keeps customer/trunk claims without a new browser
   claim. A newer interactive call retains its own slot/capacity ownership.
4. Every unfinished/active supervisor session has its own uncertain channel claim.
   No legacy readiness flag becomes a verified Desk controller; pause is unchanged.

Backfill uses the call UUID (supervisor session UUID for supervision) as operation
identity, `origin='legacy_backfill'`, `generation=1`. Missing/contradictory evidence
blocks admission; it never establishes spare capacity. Resolve overcounts from
runtime evidence instead of changing immutable units or blanket deleting claims.

The required C01/C02/H01/I05 cutover procedure is:

1. Keep inbound/new admission disabled while applying the schema. Leave the marker
   pending while any legacy version can write. Migrations are forward-only.
2. Before cutover, pause all legacy admission/executor producers across replicas;
   preserve the ESL backlog and drain/account for in-flight sends. Rerunning the
   migration runner does not recapture work written after the baseline.
3. With a stable boundary, recapture unfinished/contradictory calls, concrete legs,
   background voicemail and supervisors. Compare them and durable operations with
   authoritative FS channels/registrations, including FS orphans absent from SQL
   and ambiguous lost acknowledgements.
4. Bind surviving claims/slots to actual operation/participant/token. Retain
   uncertainty until backlog-aware cleanup is confirmed. Multiple conversations
   for one agent block that agent's admission.
5. Under admission, release only confirmed obsolete claims with full fencing;
   initialize free slots only after every old command/leg is resolved. Preserve
   pause. Issue fresh Desk identities and verify their pinned endpoints.
6. Record the completed reconciliation timestamp only once all shared writers use
   the new protocol. Verify its guard, FS hard caps and I01–I05 before enablement.

Steps 2–6 are implementation prerequisites, not a script claimed to run in B02.
There is no command here that marks all agents free or enables admission. Old
binaries do not maintain new claims; rollback needs new admission disabled and
another reconciliation before re-enabling. B02 tests preserve this explicit boundary.

## Verification

```bash
npm run test:inbound:db:isolated
npm --workspace @outbound-dialer/api test
npm run quality
git diff --check
```

The dedicated runner includes B02/A07/B01 and serializes files. Migration 019's
concurrent index creation can wait on a session waiting on the global migration
lock; parallel schema-migration suites can deadlock despite separate schemas.
Race competitors inside B02 still use independent PostgreSQL backends and barriers.

- B02.1: fresh schema, direct conflicting inserts/updates, ownership/lifecycle
  constraints; controller/slot/capacity uniqueness in both commit orders plus rollback.
  `pg_blocking_pids` proves blocking before the winner commits.
- B02.2: all five occupied states; wrong agent/call/reservation/generation no-op;
  new identities/generations; absent cleanup; rollback; stale finalizer blocked
  during release/replacement then revalidating against the new reservation. Unit
  coverage confirms no DB access without cleanup evidence.
- B02.3: exact 001–025 upgrade; paused active owner, released voicemail, pre-send
  uncertainty, terminal residual leg, supervisor and idle/new agents. Compare
  legacy rows/checksums, repeated runner, old index, no fabricated controllers,
  false free slots or missing known resource claims.

Reports `b02-{constraints,concurrency,fencing,upgrade}-report.json` retain assertions,
actual PostgreSQL version and persisted slots/capacity/marker. The runner retains
hashes/base revision and container/schema cleanup evidence. Test reconciliation
uses explicitly simulated SQL, not an FS absence check. This supplies U/DB proof;
FS/browser/provider, target cutover/storage, hosted CI and enablement remain separate.

## Local verification record — 2026-11-14

Node 23.7.0 (required >=22); changes remain uncommitted on the branch above.

| Command / environment                                                                                               | Result / local evidence                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:inbound:db:isolated`, pinned PG 17.11                                                                 | PASS 7 integration tests, no skips; `/tmp/outbound-inbound-db.3win6RcZ`. Subsequent final-code PG 17 coverage is also included in quality below.        |
| `bash /tmp/b02-quality-db.sh`, disposable PG 17.11, running `npm run quality` with its explicit `TEST_DATABASE_URL` | PASS: 287 API, 135 web, 76 ops tests; zero skips; OpenAPI/lint/format/types/build. `/tmp/outbound-inbound-db.nNPhfpjB/result.txt` and B02 JSON reports. |
| `bash /tmp/b02-postgres16-db.sh`, disposable PG 16.16, running `npm run test:inbound:db`                            | PASS all 7 A07/B01/B02 integration tests, zero skips. `/tmp/outbound-inbound-db.hE9mt3AN/result.txt` and B02 JSON reports.                              |
| `git diff --check`                                                                                                  | PASS.                                                                                                                                                   |

Both temporary wrappers derive from `scripts/test-inbound-db.sh`: the first changes
only root resolution and the final command to quality; the second changes root
resolution and the cached image to digest
`sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663`.
Containers had `--network none`, no published ports, private test sockets, and were
removed. Schema cleanup assertions passed. Evidence paths are local temporary
artifacts; they are not hosted uploads. No external calls, production changes,
Actions execution, commit, push, PR or deployment occurred.
