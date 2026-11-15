# D01 — Real browser transport recovery

Date: 2026-11-15. [Issue #21](https://github.com/sptmru/outbound-freeswitch-dialer/issues/21).
Branch: `feat/d01-browser-recovery`, based on merged `c363470`.
Follow-up changes remain local and uncommitted. The owner decides issue closure.

## Verified defect and change

The real browser reproduced `callState: active -> none` after a WSS-only socket
drop. `onDisconnect` called `failRegistration`, which cleared the invitation and
remote audio and stopped the UserAgent. SIP.js stopping a UserAgent disposes its
sessions. Registration loss was incorrectly allowed to tear down established media.
Baseline runtime evidence: `/tmp/outbound-d01.uYLNcrD9/browser-report.json`.

The hook now retains the invitation, peer connection, remote audio and telemetry
during transport loss. Native Desk transport recovery retries at most five times,
with a two-second interval; an established legacy call also uses this recovery
path. Retry exhaustion or a registration failure preserves existing media.
Unmount still explicitly terminates its own session and cancels recovery.

Registration loss immediately clears local Desk readiness. A delayed successful
heartbeat cannot restore local readiness while SIP is disconnected. Re-registration
acceptance is handled even when SIP.js keeps its existing `Registered` state and
does not emit another state-change event. The initial REGISTER promise also
preserves an already received `Registered` event.

The server's endpoint pin remains immutable. A new WSS connection changes the
native contact's `fs_path`; renewal of the occupied controller does **not** make
that moved contact eligible. Generation, pin and full slot tokens are preserved.
After the call ends and the slot is reconciled free, a new Desk generation can
establish a fresh pin. No ordinary takeover is allowed while occupied.

## Runtime fixture and results

`npm run test:desk:browser` runs `scripts/test-d01-desk.sh --browser`:

- Disposable pinned FreeSWITCH 1.10.12 and PostgreSQL 16 containers share a
  `--network none` namespace. No host ports, application `.env`, provider calls,
  production services, deployment or hosted CI are involved.
- Real Chromium 149 runs the production `useSoftphoneRegistration`,
  `DeskSessionController`, SIP.js and HTTP adapter. A small React harness supplies
  fixture bootstrap; this is not the full App or future D/E/G end-to-end flow.
  D01 HTTP handlers, schema, provisioning and reconciliation are real.
- Ephemeral local WSS certificates and Chromium test-only certificate trust are
  confined to the isolated lab. A TCP relay drops WSS without changing RTP.
- Chromium's native file-backed fake microphone sends 880 Hz. A real UDP PCMU
  customer sends 440 Hz. Web Audio verifies decoded browser receive audio;
  decoded far-end RTP verifies the browser transmit audio. WebRTC transport stats
  additionally show connected DTLS and the same peer connection throughout.
- Reservations are seeded with inbound/outbound/transfer shapes. Each covers
  `reserved`, `connecting`, `active`, `releasing` and `uncertain`: takeover
  rejection, WSS loss, blocked HTTP heartbeats, accelerated database expiry,
  reconciliation, continuing media and same-controller registration/lease renewal.
  Transfer setup has separate source/recipient participants and slots, a real
  `call_transfers` row, browser/`transfer_overlap` capacity claims and a real
  parked UDP source leg. Every case compares all call slots, capacity claims and
  transfer rows before/after loss and recovery. These are real product rows and
  real media legs, with fixture-controlled setup and teardown.
  This is not provider traffic or execution of future ingress/transfer executors.

Final artifact: `/tmp/outbound-d01.6PwUrEVC/browser-report.json`, with source
hashes, image digests, isolation metadata, safe SIP method/status metadata,
selected ESL event metadata and container teardown logs in the same directory.
All **15 media/occupied-state cases passed**. Browser leave revocations committed;
fixture teardown reached **zero live channels** and no unrevoked controllers.

The command nevertheless exits **1**, deliberately, because the additional
terminal check below failed in all three direction shapes. Its report status is
`matrix_passed_with_failed_terminal_check`. This is not an overall passing
browser runtime gate. `D01_BROWSER_SMOKE=1 npm run test:desk:browser` runs only
inbound/active for diagnosis; it is not the full matrix.

## Remaining terminal signaling failure

After WSS reconnect, explicit FreeSWITCH hangup produced
`CHANNEL_HANGUP_COMPLETE`/`CHANNEL_DESTROY`, but no BYE arrived on the browser's
new socket. The browser retained its SIP session. The fixture recorded this as a
failure, then used an explicit browser hangup for teardown; it did not count that
cleanup as successful remote termination.

A separate diagnostic run accepted both a renewed REGISTER and an in-dialog
re-INVITE with 200 responses, but remote BYE still failed:
`/tmp/outbound-d01.tA8S4dZ0/browser-report.json`. The ineffective re-INVITE was
removed from the final implementation. The precise runtime routing failure
still needs resolution; no production failure is inferred from this lab alone.

The pinned FreeSWITCH source converts `fs_path` into cached route data and uses
the cached `route_uri` for BYE. That supports investigating the old WSS route,
but changing the controller's endpoint pin would violate the accepted binding
contract. See [contact route parsing](https://github.com/signalwire/freeswitch/blob/v1.10.12/src/mod/endpoints/mod_sofia/sofia_glue.c)
and [BYE routing](https://github.com/signalwire/freeswitch/blob/v1.10.12/src/mod/endpoints/mod_sofia/mod_sofia.c).

Remaining work is to provide safe terminal recovery after a changed WSS flow:
either restore established-dialog signaling without weakening generation/pin
fencing, or terminate the browser session from correlated, confirmed API/FS
terminal evidence. Then prove remote hangup, browser cleanup and no orphans in
the same matrix. Do not infer hangup from heartbeat loss, registration expiry,
silence or an arbitrary timer. Native activation remains I05.

## Regression checks

| Command                                                                                                  | Result / artifact                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run quality`                                                                                        | PASS: OpenAPI, lint, format, types, API 287 passed / 76 DB-dependent skips, web 145 passed, operations 76 passed, build. `/tmp/d01-followup-quality.log`. The later test-fixture additions also passed focused ESLint, Node syntax and formatting checks. |
| `INBOUND_PG_STORAGE=tmpfs npm run test:inbound:db:isolated`                                              | PASS, 77/77, zero skips. `/tmp/outbound-inbound-db.P6CJmkaR/`, `/tmp/d01-followup-db.log`.                                                                                                                                                                |
| `npm run test:desk:freeswitch`                                                                           | PASS, nine groups / 15 UDP occupied-media cases, including two-client takeover/stale refresh/unregister/close. `/tmp/outbound-d01.TKfZbgCl/`, `/tmp/d01-followup-udp.log`.                                                                                |
| `npm run test:desk:browser`                                                                              | **Exit 1**: 15/15 real WSS/WebRTC preservation cases passed, three remote-BYE checks failed; fixture terminal cleanup and leave completed. `/tmp/outbound-d01.6PwUrEVC/`, `/tmp/d01-real-browser-final.log`.                                              |
| `npm run test:e2e -- tests/e2e/desk-sessions.spec.ts`                                                    | PASS, Chromium 1/1; full App, simulated API/SIP/media. `/tmp/d01-followup-e2e.log`.                                                                                                                                                                       |
| `npm --workspace @outbound-dialer/web test -- src/desk-session.test.ts src/softphone.lifecycle.test.tsx` | PASS, 19/19; also included in quality. `/tmp/d01-focused-web.log`.                                                                                                                                                                                        |
| `git diff --check`, `bash -n scripts/test-d01-desk.sh`, `node --check scripts/d01-browser-probe.mjs`     | PASS.                                                                                                                                                                                                                                                     |

The prior disk-backed lock-timeout failure was independently reproduced **before
D01**. An archive of `4fc84ef5684bef343f1369f085335680932e97b3` was extracted into
`/tmp/outbound-d01-baseline.EbUIDyZ8`; installed dependencies were linked from the
unchanged lockfile. Only the runner's revision-capture command was adjusted for
the archive without `.git`. Running `bash scripts/test-inbound-db.sh` there used
the original disk-backed container, resource limits and lock timeouts. Result:
**68/71**, with lock-timeout failures in C02.1, C03.3 and C07.1. Artifacts:
`/tmp/outbound-inbound-db.PHkQlVZG/`, `/tmp/d01-baseline-db.log`.
No D01 code or migration 033 was present. This establishes a pre-existing failure;
it does not establish its physical storage/WAL cause or target-storage performance.
No lock timeout, fsync or capacity threshold was weakened. Tmpfs success remains
a correctness result and does not replace disk-backed performance acceptance.

Historical D01 evidence is in [the original handoff](inbound-desk-sessions.md).
Issue #21 remains open and tracker #1 remains unchanged, as requested by the owner.
