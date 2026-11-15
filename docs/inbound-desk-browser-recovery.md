# D01 — Browser transport and terminal recovery

Date: 2026-11-15. [Issue #21](https://github.com/sptmru/outbound-freeswitch-dialer/issues/21).
The owner committed the first transport recovery as `433f26c`. The terminal
recovery follow-up is local/uncommitted on `fix/d01-terminal-recovery`, based on
that commit. Issue closure remains the owner's decision.

## Behavior

A WSS disconnect preserves the established invitation, peer connection, remote
audio and telemetry. Registration loss immediately clears Desk readiness. Native
Desk / established-call transport recovery makes at most five attempts, two
seconds apart. Exhaustion and registration failure do not terminate media.
Unmount still explicitly ends its own session and cancels recovery.

After registration recovers, a watcher checks the **same SIP dialog** immediately
and every five seconds, using an offerless re-INVITE (`withoutSdp: true`). A
correlated **481 Call/Transaction Does Not Exist** from FreeSWITCH confirms that
this dialog has ended. The browser then sends its own BYE and closes that SIP
session through the normal SIP.js lifecycle. This closes WebRTC, stops its
microphone tracks, removes remote audio and finalizes telemetry. No API mutation
releases a slot or capacity because of this browser cleanup.

A 200 response preserves the session and completes the normal offer/answer/ACK
exchange on the existing peer. A 408, other rejection, missing response or send
error preserves media. This is terminal confirmation from FreeSWITCH, not an
inference from heartbeat expiry, elapsed time, silence or registration state.
[SIP dialog response handling, RFC 3261 section 12.2.1.2](https://www.rfc-editor.org/rfc/rfc3261#section-12.2.1.2)
describes 481 handling. INFO is unsuitable here: the pinned FS build returned
200 even after the dialog was removed; that method is not used by this fix.

SIP.js owns each INVITE transaction and its pending-reINVITE guard. The watcher
never disposes that transaction on a transport change. A previous transaction
may remain pending until its normal 32-second deadline, delaying a fresh probe;
confirmation then waits for the next five-second check. The runtime gate allows
45 seconds for that case. Timeouts themselves do not end the call.

Callbacks are fenced by registration generation, invitation identity and probe
attempt. A reply from a disconnected flow, an old invitation or an unmounted
Desk cannot close a replacement call. Normal termination/unmount stops the
watcher. The hook also ignores late state changes from previous invitations.

The server endpoint pin remains immutable. A moved/ambiguous WSS contact stays
unready, even when the same occupied controller renews its lease. Generation,
slot and capacity tokens remain unchanged. After confirmed server reconciliation
frees the slot, a new Desk generation can establish a new pin. Native bootstrap
and executor activation remain I05.

## Runtime evidence

`npm run test:desk:browser` runs `scripts/test-d01-desk.sh --browser`:

- Pinned FreeSWITCH 1.10.12 and PostgreSQL 16 share a disposable `--network none`
  namespace. No host ports, application `.env`, provider traffic, production
  services or deployment are involved. The browser profile uses `auth-calls=true`
  as in the repo production template, with real Digest REGISTER authentication.
- Real Chromium 149 runs the production hook, controller, SIP.js and HTTP adapter.
  D01 routes, schema, provisioning, contact lookup and reconciliation are real.
  A small React harness supplies bootstrap; full App / future D/E/G call execution
  is not claimed. Ephemeral WSS certificates and test-only certificate trust are
  confined to this lab.
- Browser-native file-backed fake microphone capture sends 880 Hz; a real UDP
  customer sends 440 Hz. Web Audio and decoded far-end PCMU validate both audio
  directions. DTLS remains connected and the same media peer survives reconnect.
- Fifteen cases cover inbound/outbound/transfer reservations across `reserved`,
  `connecting`, `active`, `releasing`, `uncertain`: rejected takeover, WSS loss,
  blocked HTTP heartbeat delivery, accelerated DB expiry, reconciliation and
  same-controller registration/lease renewal. All slot, capacity and transfer rows
  are compared before/after loss and recovery. Transfer includes separate source
  and recipient slots, `call_transfers`, `transfer_overlap` permits and a real
  parked UDP source leg. Reservation setup is fixture-controlled.
- A signaling hold of at least 35 seconds exceeds the SDK transaction deadline while decoded
  bidirectional media remains active. Buffered requests are discarded before
  reconnect. The timeout does not terminate the browser session.
- All three direction shapes test confirmed remote termination. Transfer also
  ends while WSS is disconnected; the browser retains its session until it can
  obtain terminal evidence after reconnect. Each check correlates Call-ID/CSeq,
  asserts a closed peer, stopped sender tracks and removed audio, and verifies
  that browser termination did not change server slots. There is no forced
  browser-hangup fallback in the test.
- Terminal **fixture** reconciliation marks ended rows and releases reservations
  only after concrete channel absence. Final checks require zero live channels,
  unrevoked Desk controllers, occupied slots and unreleased capacity claims.
  This is not proof of future G/native cleanup executor wiring.

Both audio directions require a fresh decoded tone window within a fixed bound.
The PCMU amplitude/noise thresholds are unchanged. The report records far-end
window retries and settling time. These are checkpoint audio assertions, not a
claim of lossless or glitch-free media quality.

Final authenticated matrix: **PASS, exit 0, 22 groups / 15 occupied-media cases**.
Artifact: `/tmp/outbound-d01.PgWsg1Em/browser-report.json`, log
`/tmp/d01-terminal-browser-verified.log`. All three terminal checks received a
real 481 for the matching dialog. Confirmation took about 24.2 seconds after the
interrupted transaction, 4.2 seconds for outbound and 2.1 seconds for transfer
termination during disconnection. All 38 far-end audio windows passed the
original thresholds on their first attempt (zero retries, at most 528 ms to
collect the fresh window). The final source hashes were rechecked successfully.
Artifacts retain source hashes, image digests, isolation metadata, safe SIP
method/status/Call-ID/CSeq metadata, selected ESL events and container teardown.
`D01_BROWSER_SMOKE=1 npm run test:desk:browser` runs only inbound/active and does
not replace the full matrix.

Raw unsolicited BYE delivery over the old FS route is not repaired. The fix
recovers terminal browser state through a new request on the restored WSS flow
and a confirmed 481. Provider, target-network/device, load, rollback and broader
I02/I04/I05 enablement gates remain separate. If signaling remains unreachable,
media is deliberately retained until explicit action or terminal evidence.

## Recorded checks

- `npm run quality`: PASS; API 287 passed / 76 DB-dependent skips, web 152 passed,
  operations 76 passed, OpenAPI/lint/format/types/build passed.
  `/tmp/d01-terminal-quality.log`.
- Focused watcher/controller/hook tests: 26/26 PASS, including 408/send failures,
  pending request bounds, late callbacks, replacement invitations and unmount.
  `/tmp/d01-terminal-unit-final.log`.
- `npm run test:e2e -- tests/e2e/desk-sessions.spec.ts`: Chromium 1/1 PASS; full App
  with explicitly simulated HTTP/SIP/media. `/tmp/d01-terminal-e2e.log`.
- `npm run test:desk:freeswitch`: PASS, nine groups / 15 UDP occupied-media cases,
  including the two-client takeover/refresh/unregister/close scenarios.
  `/tmp/outbound-d01.y0l4pQs1/`, `/tmp/d01-terminal-udp.log`.
- `git diff --check`, full Prettier, `bash -n scripts/test-d01-desk.sh`,
  `node --check scripts/d01-browser-probe.mjs`: PASS.
- An initial full terminal matrix with the previous fixture's `auth-calls=false`
  passed 22 groups, including all 15 occupied cases, the signaling hold and three
  terminal checks: `/tmp/outbound-d01.VRVLLPiq/`. Confirmation times were about
  24.2 seconds after the held transaction, 4.2 seconds for outbound and 2.1 seconds
  for termination during the transfer disconnect.
- `auth-calls=true` smoke passed: `/tmp/outbound-d01.kpAzJhnY/`.
- An earlier authenticated full run stopped on one selected PCMU window scoring
  468.9 below the unchanged 500 amplitude floor:
  `/tmp/outbound-d01.M0gjB2rG/`. The final fixture waits up to five seconds for a
  fresh passing window and records retries; it does not lower the tone/noise
  thresholds. The failed run is not counted as passing evidence.

The backend and migrations are unchanged in this terminal fix. The preceding
backend gate passed 77/77 on tmpfs (`/tmp/outbound-inbound-db.P6CJmkaR/`); that
broader backend result is historical, not a rerun here. The current runtime
fixture independently uses real PostgreSQL and native D01 HTTP handlers.

The independent pre-D01 disk baseline `4fc84ef` gave 68/71 with lock timeouts in
C02.1, C03.3 and C07.1 (`/tmp/outbound-inbound-db.PHkQlVZG/`). It contained no D01
code or migration 033. Its physical storage/WAL cause and target-storage
performance remain unproven; no lock/fsync/capacity thresholds were weakened.
Tmpfs correctness does not replace disk-backed performance acceptance.

See [the original lifecycle handoff](inbound-desk-sessions.md) for schema/API and
prior backend evidence. Issue #21 and tracker #1 remain unchanged pending the
owner's decision. No commit, push, PR, deployment or hosted CI was performed.
