# I03 inbound load runner

Run with Node.js 22.13 or newer, local workspace dependencies and Docker.
Use the pinned images listed in the [inbound harness](inbound-test-harness.md).
The SIP/RTP command also needs permission to enter a Linux network namespace.
Every command creates disposable resources. The fixtures accept no target host,
DID, numbers, database URL or application configuration. Phone numbers, users,
and media are synthetic.

```bash
npm run test:load:inbound -- control smoke
npm run test:load:inbound -- control reference
npm run test:load:inbound -- sip-rtp
```

The default command runs `control smoke`. The DB uses a disposable disk volume
by default. To diagnose SQL contention without physical storage, set
`INBOUND_PG_STORAGE=tmpfs` explicitly. This keeps the same assertions and timing
limits. It cannot establish storage performance or restart durability.

## What the commands exercise

| Command             | Workload                                                                                                                                                                                                                                                    | Evidence                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control smoke`     | 20 eligible simulated Desk endpoints, 20 simultaneous ingress imports, one FIFO ring-all and competing accepts, idempotent replay, a second queue, Ignore, pause, expiry, manual outbound, and lowered capacity. The open-loop wave offers 10 calls at 5/s. | Real Fastify handlers via injection, PostgreSQL transactions and persisted call/offer/operation/slot/leg/capacity state, with explicit simulated ingress and terminal media events. |
| `control reference` | Same control scenarios and a 60-second open-loop wave with 300 offered calls at 5/s. The arrival wave holds admitted calls for one second against four queue places to exercise both admission and rejection.                                               | Same control-plane boundary. Dedicated host and storage qualification must be recorded separately.                                                                                  |
| `sip-rtp`           | 20 correlated Desk fixtures compete for one SIP customer with decoded two-way RTP. A 20-INVITE synchronized arrival wave overloads the narrow local ingress guard while the established call remains up.                                                    | Actual pinned FreeSWITCH, PostgreSQL, local UDP SIP/PCMU and explicitly injected staged coordinators. Desk pins are seeded. No Chromium or WebRTC.                                  |

The runner uses seed 606 to order the competing accept launches. PostgreSQL
resolves the actual winner. Assertions inspect the durable winner, physical or
simulated leg counts, unaffected offers, overload outcome, and final residuals.
The SQL runner records retained claims when the queue limit is lowered and
checks admission resumes after terminal cleanup. The SIP/RTP fixture leaves
cleanup to the product reducers and waits for zero remaining FreeSWITCH channels.

## Reading the report

Control artifacts are in the printed `/tmp/outbound-inbound-db.*/` directory.
Use `i03-control.json`, `result.txt`, database image and isolation metadata,
`source-sha256.txt`, and `container-cleanup.txt` together. The SIP/RTP report uses
the printed `/tmp/outbound-e02.*/` directory. It includes the actual terminal
SIP results, decoded tone evidence, media sample and final state.

Control admission measurements start at the scheduled ingress time and end at
the claim result. This includes scheduling, import and SQL time. Offer snapshot
measurements cover fixture dispatch and the authenticated GET response. This
measures the Fastify/DB path and omits browser rendering and event fan-out.
Accept timings are reported independently. The single UDP connection timing
covers the winner through decoded media at both isolated peers. The report
includes raw samples, nearest-rank p95/p99, maxima, and expected rejections and
errors. Expected overload responses remain in the samples. Correctness,
missing required measurements, or configured latency limit failures produce a
nonzero exit.
The control report also retains the product admission-lock histogram, admission
conflicts and capacity-rejection counters. CPU, RSS and pool samples describe
the single fixture process. They do not establish the replica or container
resource budgets.

## I03 acceptance still required

Use the [A06 reference limits](../inbound-resource-budgets.md) for a full I03
run. These modes cover part of I03.1, I03.2 and I03.3 and provide the initial
runner/report coverage for I03.5. The full gate still requires:

- Auto-next/release boundary interleavings and repeated manual override under
  mixed load, plus campaign and session churn.
- Sustained realistic SIP/RTP with multiple concurrent active calls, transfers,
  forwarding and recording, alongside browser observations.
- Slow ESL across API/executor replicas with protected control and hangup latency,
  explicit uncertain claims, and pool/lock/backlog measurements.
- A ten-minute normal-load run and a 30-minute bounded soak with API, worker and
  ESL faults, time series for every A06 resource and recovery budget, and zero
  unexplained residual state.

Provider and target deployment acceptance are tracked under I04 and I05.
