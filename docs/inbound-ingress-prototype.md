# A02 — Trusted Ingress and SIP Answer Boundary

Date: 2026-11-14. [Task A02 / #3](https://github.com/sptmru/outbound-freeswitch-dialer/issues/3),
under [tracker #1](https://github.com/sptmru/outbound-freeswitch-dialer/issues/1).
Base revision: `416767f3393f92e8ce27013cadb0341ca9e8f9c9`.
Original implementation branch: `prototype/a02-trusted-ingress`, merged into `dev`
by [PR #49](https://github.com/sptmru/outbound-freeswitch-dialer/pull/49), merge
`b5c4cd06665548dfcfc2428dbd9dadf8a20e085b`. The results below describe the original
prototype run; the documentation amendment does not claim a new acceptance run.

**Status: A02 complete in its amended local FS/R scope; provider acceptance deferred
to I04 and still mandatory before I05 target enablement.**
No product ingress, schema, API, offers, deployment or provider routing is enabled.

On 2026-11-14 the owner explicitly approved separating local development from
real-provider acceptance. This supersedes the original A02 completion boundary and
earlier comments requiring A02 to stay open. The local acceptance criteria are
mapped below; no provider check was waived, run or marked passed by this change.

## Selection and scope

GitHub REST returned the tracker and all 46 tasks A01–I05. A01 #2 was closed with
its completed source-review artifact. A02's description and Dependency links require
only A01, making A02 the first dependency-ready task by ID. Before the start comment,
#3 was checked again: open, no assignees, zero comments, no development PR in its
timeline and no open PR anywhere in the repository. The initial working tree was clean.
Tracker checkboxes and issue-number ordering were not used to infer dependencies.

Requirements: [source plan sections 6, 6.1, 7, 10 and 13.4](inbound-calling-implementation-plan.md),
[requirements](requirements.md), [architecture](architecture.md),
[implementation status](implementation-plan.md), and [environment contract](environment-configuration.md).
Production uses the existing [entrypoint](../infra/freeswitch/entrypoint.sh), which
continues to install the public rejection policy. The new prototype directory is
outside its template tree and outside the Dockerfile's template copy.

## Reproduce the isolated prototype

Prerequisites: Linux, Docker, Node.js 22+, `nsenter`, and permission to create a
disposable container and enter **its network namespace**. The image must already be
present. Fetch only the repository's pinned base image if necessary:

```bash
docker pull safarov/freeswitch@sha256:b31c743f4c911a19687c61e3214968f2a24f93f9d3d667cc26284192e158ffc6
npm run test:prototype:ingress
```

The runner does not source `.env` or invoke product Compose. It creates one randomly
named container with `--network none`, no published ports, all capabilities dropped,
512 MiB memory and 128 PID limits. Host Node enters only that new container's network
namespace. The FreeSWITCH SIP/ESL/RTP listeners and both clients use loopback there;
neither provider nor host-network traffic is reachable. No existing service is
restarted. The EXIT trap captures logs and removes the test container even on failure.

This is a test fixture, separate from deployment through `.env`/Compose/`scripts/deploy.sh`.
The fixed ESL password is disposable fixture data, reachable only in that namespace.
Eight-session/channel-rate settings and a 750 ms wait are fixture values, not A06's
accepted resource or performance budgets. There are no new deployment environment variables.

Sources:

- [Standalone repo-owned FS template](../infra/freeswitch/prototypes/a02/freeswitch.xml.tpl).
- [Containment and cleanup runner](../scripts/test-a02-ingress.sh).
- [Real UDP SIP/RTP client, ESL observer and assertions](../scripts/a02-ingress-probe.mjs).
- [Evidence-checker regression tests](../tests/a02-ingress.test.mjs), discovered by `test:ops`.

The fixture uses the pinned **base** image, FreeSWITCH 1.10.12 / `a88d069d6f`, on amd64.
It does not build the full product image with its AVMD patch, load the deployed
external profile, test browser WSS/ICE, or exercise a real SIP trunk.

## Observed local protocol

Trust is a literal match against FreeSWITCH's transport `network_addr`,
`127.0.0.2`. `127.0.0.3` represents an untrusted peer. There is no SIP registration
or digest authentication in this loopback fixture. This demonstrates an IP-source
gate, not the existing provider's actual ingress authentication mechanism.

The lab DID is the Request-URI user exposed as `destination_number`. Only
`+12025550100` and `12025550100` map to enabled `+12025550100`, revision `fixture-v1`.
`+12025550101` is disabled; all other destinations are unknown. This deliberately
finite normalization is a fixture, not a general phone-number validator. Production
normalization must retain strict validation and use the actual observed provider DID
field. `From`, `P-Asserted-Identity`, `Diversion` and caller-supplied `X-*` values do
not select an enabled route or establish trust.

The template clears `outbound_dialer_call_id`, `outbound_dialer_operation_id`,
`outbound_dialer_supervisor_session_id` and `outbound_dialer_leg_type`. It never maps
SIP headers into them. After trust/DID validation it assigns `a02_ingress_uuid` from
FreeSWITCH's `${uuid}`, alongside the fixed validated DID/revision. Product call and
operation IDs remain unset: allocating them durably belongs to later admission work.

Forged INVITEs include `X-Outbound-Dialer-Call-ID`, `X-Outbound-Dialer-Operation-ID`,
`X-Outbound-Dialer-Supervisor-Session-ID`, `X-outbound_dialer_call_id`,
`variable_outbound_dialer_call_id`, fabricated trust/DID headers, PAI and Diversion.
Assertions inspect channel and custom-event authority fields, ingress UUID, exact
validated DID/revision, one incoming channel, no `CHANNEL_BRIDGE`, terminal evidence
and eventual `show channels as json` count zero. This is a real FS gate test with
synthetic peers. There is no database/API in this fixture, so it does not prove a
future product offer transaction; zero outbound legs is verified through the FS
channel/event evidence, while offer creation is structurally absent.

### Admission and audio boundary

Default mode validates ingress, waits 750 ms, then sends `503 Admission unavailable`
without answer or RTP. This models a bounded unavailable admission service; it
does not implement A03's durable capture, commit/ack or outage recovery protocol.
Rejected attempts have local test artifacts only, with no promised product history.

The alternate modes simulate successful admission solely to inspect audio:

- `early-wait`: `pre_answer`, one second of a 440 Hz tone, then explicit `480`.
  The local peer receives `183` with SDP and RTP, without `CHANNEL_ANSWER` or `200`.
  No assumption is made that a provider will pass this audio to a PSTN caller.
- `answered-wait`: `answer`, one second of the same tone, then hangup.
  The peer receives `200 OK`, sends ACK and receives BYE. One `CHANNEL_ANSWER`
  occurs before waiting audio. No agent leg or `CHANNEL_BRIDGE` exists.

The soft RTP timer makes playback advance without inbound client RTP. Both PCMU
and PCMA are exercised for answered audio. The probe decodes received G.711 payloads
and checks the known tone's frequency, sustained packet count and absence of RTP
before the declared `183`/`200` boundary. These are synthetic far-end audio samples,
not browser two-way media or human/provider listening evidence.

For the proposed call model, record PSTN answer independently from
`agent_connected_at`. Waiting-mode `CHANNEL_ANSWER` must never be treated as agent
connection. Whether early media is delivered, whether answer is required to hear
waiting audio, and when charging starts require target-provider observations and
confirmation. SIP signaling alone cannot establish the provider's billing policy.

### Results and artifacts

Final FS run: `npm run test:prototype:ingress` — **PASS**, nine scenarios, exit 0.
Time: 2026-11-14 11:53 Asia/Yerevan (07:53 UTC); Node v23.7.0.
Artifacts: `/tmp/outbound-a02.quYl9MbQ/`. These are local artifacts, not uploaded
GitHub attachments or production evidence. The result table is also published in
the issue handoff. Failed development runs are not acceptance evidence.

| Scenario                                   | Observed SIP                                                  | Elapsed to final response / complete dialogue | Received RTP |
| ------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------- | ------------ |
| Trusted enabled DID, unavailable admission | `503 Admission unavailable`                                   | 749 ms                                        | 0            |
| Same DID without plus                      | `503 Admission unavailable`                                   | 750 ms                                        | 0            |
| Untrusted source with forged headers       | `403 Untrusted ingress`                                       | 10 ms                                         | 0            |
| Unknown DID with forged headers            | `404 Unknown DID`                                             | 10 ms                                         | 0            |
| Disabled DID                               | `403 DID disabled`                                            | 10 ms                                         | 0            |
| Trusted enabled DID with forged headers    | `503 Admission unavailable`                                   | 749 ms                                        | 0            |
| Early waiting audio, PCMU                  | `183 Session Progress` then `480 Waiting ended before answer` | 1008 ms                                       | 50 packets   |
| Answered waiting audio, PCMU               | `200 OK` then BYE                                             | 1012 ms                                       | 50 packets   |
| Answered waiting audio, PCMA               | `200 OK` then BYE                                             | 1012 ms                                       | 50 packets   |

Each audio scenario received 8,000 decoded samples; the positive zero-crossing
estimate was 439 Hz for the 440 Hz fixture. For each scenario: exactly one incoming
channel, no bridge/agent connection, no forged product authority and zero channels
after cleanup. Unknown, disabled and untrusted ingress emitted no validated event.
The unavailable cases had no answer event. Early waiting audio had no answer event;
each answered case had exactly one. No trust/DID or unavailable-admission refusal
emitted RTP.

Local final causes were `NORMAL_TEMPORARY_FAILURE` for 503, `CALL_REJECTED` for
403, `UNALLOCATED_NUMBER` for 404, `NO_USER_RESPONSE` for the early-media 480, and
`NORMAL_CLEARING` for the answered dialogues.

The artifact directory includes:

- `report.json`: each received SIP first line/header/SDP, relative timestamps,
  synthetic SIP Call-ID, decoded-audio summary, RTP payloads, correlated ESL
  events, scenario status and final channel count.
- `events.json`: subscribed FS channel events and the named custom subclass.
- `freeswitch-unavailable.xml`, `freeswitch-early-wait.xml`,
  `freeswitch-answered-wait.xml`: exact rendered modes; `freeswitch.xml` is the
  final active fixture.
- `image.txt`, `base-revision.txt`, `source-sha256.txt`, `tracked.patch`,
  `container-id.txt`, `isolation.txt` and `container.log`: provenance, configuration
  containment and diagnostics. Isolation was `"none" {}` (no published ports).

The report captures synthetic fixture identities only. The FS console logs include
expected permission warnings for real-time scheduling after all capabilities were
dropped, and initial empty SQLite schema messages; those were not treated as SIP
or admission failures. All assertions still have to pass.

`report.json` SHA-256: `be0d0b8ffdfc26889e457bc864be8c50718154a4e2ba7811d29e8841401b5e74`.
`sha256sum -c /tmp/outbound-a02.quYl9MbQ/source-sha256.txt` passed for the exact
runtime template, runner and probe sources after the run.

Additional local validation:

- `node --test --test-isolation=none tests/a02-ingress.test.mjs` — PASS, three
  evidence-checker tests. They verify that missing/invalid evidence fails; they are
  U coverage, separate from the real FS run.
- `npm run quality` — PASS, exit 0 when local TCP sockets were permitted: OpenAPI
  consistency, lint, formatting, typecheck, 262 API tests, 134 web tests across 13
  files, 49 operational tests and all workspace builds. Log:
  `/tmp/outbound-a02-quality-unsandboxed.log`.
- The first sandboxed `npm run quality` failed because existing
  `agent-registrations.test` / `esl.test` could not bind local sockets (`listen EPERM`).
  The focused diagnosis and successful rerun required no application change.
- `npm run test:ops` and `npm run build` also passed independently before the full
  gate completed. `bash -n scripts/test-a02-ingress.sh`, `git diff --check`, targeted
  whitespace/EOF assertions and all 27 relative Markdown links across this report
  and the source plan passed.

`TEST_DATABASE_URL` and `VOICEMAIL_TEST_PG_SOCKET` were unset. Their guarded real
PostgreSQL suites were not exercised; aggregate runner output does not constitute
DB proof. No `test:e2e`, product `test:freeswitch`, load, restore or provider matrix
was run. The separate A02 command above supplies only its declared FS coverage.

## Amended acceptance and transferred provider gate

| Criterion | Completed local FS/R scope                                                                                                                                            | Provider obligations retained under I04                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A02.1     | Lab transport trust, enabled/unknown/disabled DID and forged-header INVITEs; internal UUID and no forged authority, bridge or extra legs; zero channels after cleanup | I04.1: actual provider source/authentication, delivered DID field/normalization, codecs/caller ID and target ingress policy. No product DB offers are implemented by the prototype. |
| A02.2     | Local 183/early-media versus 200/answered waiting audio, decoded tone, no agent bridge; SIP answer kept separate from agent connection                                | I04.1: actual far-end delivery, whether waiting audio requires answer, two-way browser audio and explicit provider billing confirmation.                                            |
| A02.3     | Bounded unavailable-admission fixture, exact local replies/causes, no answer/RTP on refusal and explicit pre-admission history limitation                             | I04.5: provider-facing rejection, retry/disconnect/failover, timing and history guarantee; I04.2: forwarding caller-ID/From/PAI policy and forbidden-ID rejection.                  |

A02 may be closed and checked in the tracker on these amended local criteria.
Dependencies on A02, including [A03 #4](https://github.com/sptmru/outbound-freeswitch-dialer/issues/4),
now consume this documented local contract and can proceed in isolation. A03 must
still select and prove its own durable capture/commit/ack, recovery and history
guarantees with real FS + DB tests; simulated admission here proves none of those.
Do not treat the fixture's IPs/DID, 750 ms delay or eight-session settings as
production values, assume provider retry deduplication, or assume PSTN early-media
delivery. The provider's actual behavior may require later integration adjustments.

No target DID, authorized receiving endpoints, provider ingress delivery/access or
provider confirmation was supplied for the original run. Provider testing is deferred;
this amendment authorizes no provider calls, production changes or target enablement.
[I04 #46](https://github.com/sptmru/outbound-freeswitch-dialer/issues/46) remains open
and [I05 #47](https://github.com/sptmru/outbound-freeswitch-dialer/issues/47) must block
target enablement until its provider prerequisites and other gates pass.

To finish the transferred requirements under I04 in a separately authorized target
test environment, retain sanitized signaling and far-end observations with deployed
image/config revision, time and observer:

1. Record the provider's confirmed source CIDRs or authentication mechanism separately
   from outbound registration settings. Confirm whether signaling arrives through a
   trusted proxy; a caller-controlled header must not replace transport trust.
2. Call the assigned DID from an authorized external endpoint. Record the precise
   Request-URI/To/other DID field and number form, and the caller-ID source/allowed
   presentation. Exercise unknown/disabled DID and forged-header negative cases on
   the intended ingress path without permitting a direct PSTN route.
3. Compare early waiting audio and answered waiting audio at the actual far end.
   Record `183`, `200`, caller audio, agent acceptance/bridge times separately;
   obtain explicit provider billing interpretation.
4. Repeat bounded unavailable admission. Record exact provider-facing final response,
   disconnect, retransmission/retry/failover behavior and elapsed bounds. Establish
   the required guarantee for attempts rejected before durable capture under A03.
5. Obtain and test forwarding caller-ID rules: fixed owned DID versus original caller
   presentation, required PAI/From policy, allowed destinations, loop handling and
   response to forbidden caller IDs. Local From/PAI headers do not prove permission.

Provider-specific values and conclusions are **unknown**, rather than inferred from
the existing outbound `SIP_TRUNK_MODE`, gateway configuration, example env values or
historical successful outbound calls. No forwarding originate is performed by this lab.

## Development observations

The lab caught configuration and observation errors before passing: the source-check
extension needed `continue="true"` so trusted traffic reached DID selection; the
custom event uses explicit `Event-Name=CUSTOM` and a named CUSTOM subclass subscription;
`rtp-timer-name=soft` was necessary for one-way tone playback without incoming RTP.
Channel-list removal can follow `CHANNEL_HANGUP_COMPLETE`, so cleanup waits for
confirmed zero channels within a separate two-second bound. These observations apply
to this fixture; existing voicemail/event code was not changed or declared faulty.

The `event` application's comma-separated headers and event-name handling were checked
against [FreeSWITCH source at `a88d069d6f`](https://github.com/signalwire/freeswitch/blob/a88d069d6ffb74df797bcaf001f7e63181c07a09/src/mod/applications/mod_dptools/mod_dptools.c#L1764).
