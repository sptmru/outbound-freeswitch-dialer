# I02 pinned FreeSWITCH acceptance

Run on Linux with Node.js 22.13 or newer, installed workspace dependencies,
Docker and permission to enter the runner's isolated network namespaces.
Use the Playwright-managed Chromium build, OpenSSL and a working `ffprobe`.
Each component runner requires the repository-pinned FreeSWITCH and PostgreSQL
images already present in Docker. Their digests are recorded with every result.

```bash
npx playwright install chromium
npm run test:inbound:freeswitch
```

Set `FFPROBE_PATH` if the executable is outside `PATH`. The command uses disposable
containers and loopback endpoints with synthetic callers and audio. Each probe
gets a fresh namespace and a database reachable through a private Unix socket.
The harness supplies its own configuration.

| Criterion | Scenarios and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I02.1     | D02 verifies DID and trust boundaries. E02 and D04 exercise waiting RTP, explicit acceptance, CANCEL/BYE, connect failures, fallback and forwarding. G02/G04 use actual FreeSWITCH customer and agent legs for both transfer directions. H02 decodes phase-specific tones from the retained customer WAV and checks finalization. E04 measures two-way audio in Chromium and the SIP peer independently of the recording probe.                          |
| I02.2     | D03 checks before-INSERT and post-commit journal replay, no media effects on terminal imports, missing/locked/suspended/full journal, PostgreSQL outage and abrupt FreeSWITCH restart. H01 kills a worker at import and queue-admission checkpoints and resumes calls using the original ingress identity and fixed waiting operation. The live path asserts one waiting job and decoded audio and the ended path asserts no admission, media or offers. |
| I02.3     | E04 uses real Chromium registration and a separately registered obsolete SIP client for the same agent. It verifies idle takeover, denied occupied takeover, stale refresh/unregistration/close and selected inbound, outbound and transfer recipient audio through real WSS and DTLS-SRTP.                                                                                                                                                              |
| I02.4     | C03 holds six actual command transports while a reserved critical seat completes hangup. H01 exercises stale task ownership and FreeSWITCH incarnation, delayed frames and process replacement. D02 and D04 verify over-capacity ingress and forwarding. E02/G02/G04 exercise late answer/hangup, bounded retry, bridge confirmation and exact release.                                                                                                  |

## Evidence

The command prints `/tmp/outbound-i02.*/report.json`, updates it after each
probe, and exits nonzero if a child, its cleanup, or its assertions fail. It
continues to collect later independent probes after a failure. The report lists
the command and scenario names, base revision, pinned image digests, child log,
and underlying artifact path. The underlying reports contain the SIP/ESL and
operation IDs, selected timing and media measurements, DB snapshots, fixture
source hashes, and container teardown logs. Keep the raw lab logs and recordings
local and use the bounded summaries in issue reports.

The native acceptance/transfer probes follow trusted ingress through product
queueing, HTTP acceptance, handover, and terminal cleanup, using UDP SIP desk
endpoints and injected runtime wiring. The Chromium probe uses the production
softphone and authorization routes with fixture-created operations and
fixture-controlled bridge and terminal reconciliation. Its transfer fixture
verifies decoded audio on the original customer leg before and after the native
rebridge to Chromium. I04 owns provider acceptance. I05 owns supported
deployment, native bootstrap, and activation.

Use `npm run test:cleanup:freeswitch`, `npm run test:supervisor:freeswitch`, and
`npm run test:voicemail:db` for the existing isolated outbound regressions.
