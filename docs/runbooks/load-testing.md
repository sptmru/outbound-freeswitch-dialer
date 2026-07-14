# Load And Soak Testing

This runbook separates control-plane capacity from live telephony capacity. The
included runner proves authenticated Agent Desk REST polling, SSE connection
stability, proxy/API/PostgreSQL behavior, and latency thresholds. It does **not**
prove SIP-provider CPS/concurrency, WebRTC/RTP audio quality, voicemail delivery,
or browser CPU usage. Those require the controlled live-call phase below.

Never point a call-generating scenario at an ordinary client campaign or an
unapproved destination range. Confirm the provider's concurrent-call and
calls-per-second limits before any live-call phase.

## Acceptance Inputs

Record these before the capacity run. Do not silently treat the runner defaults
as the client's capacity requirement.

- target hostname, deployed SHA, operator, UTC window, and incident owner;
- required simultaneous agents and peak/average calls per minute;
- provider CPS and concurrent-channel limits;
- approved test numbers/sink, caller ID, calling window, and recording policy;
- acceptable REST error rate and p95/p99 latency;
- soak duration and acceptable CPU, memory, PostgreSQL connection/storage growth;
- stop conditions and rollback/incident authority.

The initial repository guardrails are HTTP error rate <= 1%, p95 <= 750 ms,
p99 <= 1500 ms, SSE ready rate >= 99%, and no unexpected SSE disconnects. Tighten
or relax them only as an explicit acceptance decision.

## Prepare Dedicated Test Agents

Create test-only agent accounts in Admin -> Users. Use one account per intended
concurrent virtual agent when possible. Test agents must not be assigned to an
ordinary live campaign during the read-only test.

Put one test-agent email per line in a file. Blank lines and lines beginning with
`#` are ignored. Obtain short-lived JWTs immediately before the run with the
collector; it securely prompts once for the shared test-agent password:

```bash
export LOAD_BASE_URL="https://dialer.example.com/api"
export LOAD_APPROVED_TARGET="$LOAD_BASE_URL"
npm run test:load:tokens -- test-agent-emails.txt /tmp/outbound-dialer-load-tokens
```

For non-interactive execution, set `LOAD_AGENT_PASSWORD_FILE` to a file containing
the shared password and protect it with `chmod 600`. The collector validates
that every login returns the matching `agent`, never prints tokens, writes the
complete output atomically with mode `0600`, and refuses to overwrite an existing
token file unless `LOAD_TOKENS_OVERWRITE=true` is set. Because successful logins
also consume the API's per-IP login limit, the collector observes the rate-limit
headers and waits for the next window when necessary.

Do not paste passwords or tokens into shell history, Git, tickets, or the final
report. Delete token/password files after the test. Changing a test user's
password or deactivating it invalidates outstanding tokens for that user.

## Preflight

Run from a separate load-generator host, not from the application server. This
keeps generator CPU/network limits out of server measurements. The checkout must
use Node.js 22 or newer and the same accepted SHA as the deployment.

Before starting:

1. Announce the test window and freeze deployments/imports/manual admin work.
2. Confirm `/api/health/ready`, Grafana, Alertmanager, PostgreSQL, ESL, trunk, disk,
   and container restart counts are healthy.
3. Record a baseline screenshot/export from the outbound-dialer Grafana dashboard.
4. Confirm no ordinary active calls and note the baseline database/storage size.
5. Confirm the load generator resolves the public hostname and validates TLS.
6. Keep Grafana, API logs, FreeSWITCH logs, and provider channel/CPS counters open.

Do not disable alerting. Tell responders which alerts are expected and retain
their delivery timestamps as evidence.

## Read-only Agent Desk Test

The runner first validates every token through `GET /auth/me`. Each steady
virtual agent then keeps one credentialed `GET /agent/events` SSE connection and
polls authoritative `GET /agent/desk` with a two-second interval plus jitter,
matching the application fallback behavior. Results contain no JWTs and are
written with mode `0600`.

Run a small smoke first:

```bash
export LOAD_BASE_URL="https://dialer.example.com/api"
export LOAD_APPROVED_TARGET="$LOAD_BASE_URL"
export LOAD_AUTH_TOKENS_FILE=/tmp/outbound-dialer-load-tokens
LOAD_SUITE=smoke npm run test:load:suite
```

Then run the stepped capacity profile. It tests 1, 5, 10, 25, and 50 virtual
agents. Stop after a failed stage; do not continue to a larger stage.

```bash
LOAD_SUITE=capacity npm run test:load:suite
```

If the approved capacity is not one of those stages, run the underlying runner
directly at the exact target:

```bash
LOAD_PROFILE=steady \
LOAD_CONCURRENCY=80 \
LOAD_SSE_CONNECTIONS=80 \
LOAD_DURATION_SECONDS=600 \
LOAD_REPORT_PATH=logs/load-tests/80-agents.json \
npm run test:load:desk
```

Use `LOAD_PROFILE=saturation` only for a short endpoint ceiling test. It removes
the realistic polling delay and defaults to no SSE connections. It is not an
agent-capacity result.

For the soak, use the accepted concurrent-agent target. The default is 25 agents
for four hours:

```bash
LOAD_SUITE=soak \
LOAD_SOAK_CONCURRENCY=25 \
LOAD_SOAK_DURATION_SECONDS=14400 \
npm run test:load:suite
```

Useful threshold overrides are `LOAD_MAX_ERROR_RATE`, `LOAD_MAX_P95_MS`,
`LOAD_MAX_P99_MS`, `LOAD_MIN_SSE_READY_RATE`, `LOAD_MAX_SSE_DISCONNECTS`, and
`LOAD_REQUEST_TIMEOUT_MS`. Reports are under `logs/load-tests/` by default and
are intentionally ignored by Git.

## Observe During Every Stage

Watch at least:

- request rate, 4xx/5xx rate, and HTTP duration by route;
- API/proxy/PostgreSQL CPU, memory, restarts, connections, locks, and disk I/O;
- `outbound_dialer_database_metrics_up` and `outbound_dialer_stuck_calls`;
- SSE/API errors and PostgreSQL live-event listener reconnects in logs;
- `outbound_dialer_esl_listener_connected`, queue depth/capacity, retries, and
  overflows (they should remain quiet in the read-only phase);
- registered agents, active calls, trunk readiness, packet-capture storage, and
  host disk/inode usage;
- generator CPU, open files, network errors, and latency, so a weak generator is
  not mistaken for a server limit.

Stop immediately for sustained 5xx responses, readiness failure, container
restart/OOM, PostgreSQL saturation or blocking, ESL queue overflow, stuck calls,
trunk instability, disk exhaustion risk, unexpected real calls, or breached
provider limits. Preserve evidence before restarting anything and follow the
incident-response runbook.

## Controlled Live Telephony Phase

Only start this phase after the read-only test passes and the client/provider
explicitly approves real call generation. PCAP and recording settings must match
the approved data-handling policy.

Use real supported browsers for agent media endpoints; HTTP virtual users cannot
register SIP.js, negotiate ICE/DTLS/SRTP, or assess audio. Use dedicated agents,
an isolated test campaign, and approved owned test destinations or a provider
test sink. Ramp below the provider limit, for example 1 -> 2 -> 5 -> accepted
concurrency, with a conservative CPS and enough dwell time to observe terminal
state. Never infer the final numbers from this example.

At every live-call stage cover and correlate:

- WSS registrations and reconnects;
- agent/customer leg creation, ringback/early media, answer, two-way audio, DTMF,
  agent hangup, customer hangup, busy/reject/no-answer/provider failure;
- voicemail drop only on explicitly approved representative mailboxes;
- API correlation ID, call ID, both FreeSWITCH UUIDs, SIP response/hangup cause,
  `call_events`, terminal `calls` row, recording/PCAP status when enabled;
- provider CPS/channel counters and FreeSWITCH sessions/channels/RTP health;
- duplicate calls, calls stuck in a non-terminal state, agents stuck `in_call`,
  contacts stuck `calling`, and event/recording/PCAP storage growth.

Run one race/recovery drill at a time after steady-state capacity is known: SSE
network interruption, browser reconnect, API restart, ESL reconnect, and
FreeSWITCH restart. Restart drills are disruptive and require separate approval.

## Post-run Integrity Checks

After allowing watchdogs and terminal events to settle, verify the dashboard and
read-only database queries. Run these through the existing Compose environment
on the server; they must all return zero for a clean test:

```sql
select count(*) as non_terminal_calls
from calls
where ended_at is null and state not in ('completed', 'failed', 'canceled');

select count(*) as agents_stuck_in_call
from agents a
where a.status = 'in_call'
  and not exists (
    select 1 from calls c
    where c.agent_id = a.id and c.ended_at is null
      and c.state not in ('completed', 'failed', 'canceled', 'agent_released')
  );

select count(*) as contacts_stuck_calling
from contacts c
where c.status = 'calling'
  and not exists (
    select 1 from calls ca
    where ca.contact_id = c.id and ca.ended_at is null
      and ca.state not in ('completed', 'failed', 'canceled')
  );
```

Compare pre/post database, call-event, recording, PCAP, log, and disk growth.
Keep a cooldown observation window and confirm latency/error/resource metrics
return to baseline. Deactivate or password-rotate test users, remove the local
token file, and archive the JSON reports with Grafana/provider/log evidence.

The acceptance record must state the highest **passing** steady stage, soak
duration, live-call concurrency/CPS if tested, thresholds, deployed SHA, exact
commands, failures, stop reason, exceptions, and remaining unverified behavior.
