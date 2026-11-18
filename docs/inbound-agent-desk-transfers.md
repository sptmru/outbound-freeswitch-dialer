# G03 — Agent Desk transfer controls

Task: [G03 #36](https://github.com/sptmru/outbound-freeswitch-dialer/issues/36).
Local branch: `feat/g03-agent-desk-transfers`. Base: `7d77e4d`.

The staged native Desk consumer now supports both sides of a transfer. A current
connected source can choose an available colleague, request a transfer and cancel
an offered request. Availability is a hint, never a reservation: the G01 endpoint
revalidates it. An unavailable target remains unselectable; rejection discards the
hint list and refetches the Desk. The recipient explicitly accepts or declines
through the existing transfer-capable offer endpoints. The call campaign label
is separate from the recipient's selected campaign; transfers do not change either.

The source keeps its call controls while the request is offered, connecting or
switching and its server-owned active call/slot remains current. Only authoritative
Desk snapshots change ownership/control. A released/mismatched slot disables stale
controls; an absent active call removes them. Transfer statuses include offered,
connecting, switching, uncertain and all terminal results. HTTP acceptance displays
connection progress. Neither HTTP success nor elapsed deadline declares a completed
handover. A deadline triggers a refresh; server expiry remains authoritative.
No transfer action directly hangs up or answers browser media.

Explicit recipient next/lead/number dialing sends one manual-start request, with
no separate decline or confirmation. Successful admission closes the transfer UI;
failed admission retains/refetches the offer and input. Native automatic progression
still requires the server's source-bound auto intent. Source call disappearance
never creates one. Transfer mutations retain their request identity across HTTP
loss/retry, and late results cannot populate a replacement call/controller/transfer
scope. Stale call-control errors refetch; a delayed control result cannot restore a
call after handover.

## Integration boundary

This is a consumer of the existing `desk.coordination` contract and G01/G02 routes.
The default server still does not publish native snapshots or bootstrap native
execution. I05 must publish a coherent current-owner `activeCall`, exact slot,
server action availability, transfer progress and auto-intent snapshot along with
native admission/execution/recovery. H01/G04 and I01–I05 retain their separate work.
No shared contract, migration, runtime enablement, provider route or production
configuration changes are included.

Both direction fixtures use the existing connected-call UI projection (`bridged`);
they differ in caller context and represent the G01/G02 inbound/outbound source
contract. They do not originate an actual inbound or outbound call.

## Reproducible verification

Use Node.js >=22.13.0. The browser command reuses the isolated E03 Vite entry on
loopback port 4175, with `envDir: false`, no API proxy and no application credentials.
Two pages share a stateful simulated HTTP service; controller and media are
simulated. This proves browser behavior, not integrated SIP/WebRTC/RTP or provider
behavior. Traces/screenshots on failure are retained under `/tmp/g03-browser-results`.

```bash
npm --workspace @outbound-dialer/web test -- src/features/agent-desk/agent-desk-transfers.test.tsx src/features/agent-desk/agent-desk-offers.test.tsx
npm run test:desk:transfers:browser -- --workers=2
INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN='G01.3' npm run test:inbound:db:isolated
npm run quality
git diff --check
```

| Criterion | Evidence                                                                                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G03.1     | Component and paired Chromium fixtures: both direction projections, recipient discovery, busy target after selection, cross-campaign labels, create/cancel/Accept/Decline, connecting/switching and terminal outcomes.                                                                                                            |
| G03.2     | Six paired Chromium cases: next/lead/number × success/failure, held HTTP, exactly one manual mutation and preserved source. Existing real PostgreSQL G01.3 HTTP endpoint tests: all three routes, both competing commit orders and rollback, preserved source state, accepted-reservation fencing and capacity rollback.          |
| G03.3     | Component fake timers, late target/control HTTP results, deadline refresh, stale-owner refetch and no auto next after actual active-call removal. Paired browser delayed acceptance/create, reload during connecting, switching, failed switch and confirmed handover/current-owner controls. Actual media proof remains G02/I02. |

The DB command creates a pinned PostgreSQL 17.11 container with bounded tmpfs,
network disabled and no published ports. It never reads the configured application
DB. With the name filter, four substantive G01.3 tests run; the Node runner also
reports 26 empty-file subtests. Those are not 30 database scenarios.

Unrun integrated
browser/API/FS, provider, target-storage/load, hosted CI, enablement, deployment and
production acceptance are separate from these U/B/DB results. Changes remain local
and uncommitted; no push or PR is created.

## Verified local result — 2026-11-18

Node.js 22.13.0. All final commands exited zero.

| Gate                                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Focused G03 + E03 component suites                                                       | **35/35 passed** (19 G03, 16 E03), including fake timers and late Accept/owner-control responses.                                                                                                                                                                                                                                                                                    |
| `npm run test:desk:transfers:browser -- --workers=2`                                     | **18/18 passed**, paired Chromium/stateful HTTP fixtures; `/tmp/g03-browser-results/.last-run.json` records success.                                                                                                                                                                                                                                                                 |
| `npm run test:desk:offers:browser -- --workers=2`                                        | **18/18 passed**, existing E03 browser regression.                                                                                                                                                                                                                                                                                                                                   |
| `INBOUND_PG_STORAGE=tmpfs INBOUND_TEST_PATTERN='G01.3' npm run test:inbound:db:isolated` | **Four substantive DB/API tests passed**, including twelve separate-process manual/accept commit/rollback schedules. The runner reports 30 passing subtests including 26 empty-file wrappers, zero failures/skips. Artifacts: `/tmp/outbound-inbound-db.5NwpPZNn/result.txt`, source hashes, pinned image, `none {}` network/ports, tmpfs metadata and successful container cleanup. |
| `npm run quality`                                                                        | **PASS:** OpenAPI, lint, formatting, typecheck, **307 API passed / 187 skipped**, **202 web**, **78 ops**, all builds. No `TEST_DATABASE_URL` was supplied to this broad gate; skipped API checks are not DB proof. Final log: `/tmp/vscode-agent-codex-sandbox-pnhDqw/g03-quality-final.log`.                                                                                       |
| `git diff --check`                                                                       | **PASS.**                                                                                                                                                                                                                                                                                                                                                                            |

The commands used `/tmp/node-v22.13.0-linux-x64/bin` on PATH, and the quality gate
also used the existing `/tmp/f02-ffmpeg` tools. The full DB runner above supplied
its own test URL and never accessed the application database. No schema/API server
implementation changed in G03.

An initial component run had two test expectations incorrectly checking offer copy
after the successful action had removed the card; these assertions now check the
copy before submission. An initial browser assertion used Playwright's disabled
matcher for a native option despite the correct `disabled` attribute; the final
assertion checks that attribute and the disabled submit button. The final complete
G03 and E03 browser suites both passed after the last application change.

G03.1–G03.3 pass at their specified U/B/DB consumer levels. No integrated real
API/browser/SIP/WebRTC/FS/RTP, provider, target-storage/load, hosted CI, deployment,
rollback, enablement or production acceptance is claimed. G02/I02 own media proof;
I05 owns coherent native snapshot/executor bootstrap and activation. No commit,
push, PR, provider call, deployment or production change was performed.
