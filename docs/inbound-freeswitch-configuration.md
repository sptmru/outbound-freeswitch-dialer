# Versioned FreeSWITCH configuration (D02)

D02 owns the configuration publisher and the physical ingress safety boundary.
`FREESWITCH_INBOUND_CONFIG_ENABLED=false` leaves the publisher off. Enabling this
publisher is **not** product inbound enablement: even a trusted, enabled DID still
receives `503 Admission unavailable`, before answer/RTP, until D03 supplies its
separately tested durable capture/commit/ack continuation. Never call the A03 lab
journal from the product or remove that refusal to demonstrate a successful call.
D03/D04, browser/provider acceptance and I05 activation remain separate tasks.

## Desired, applied and failed revisions

Migration `034_freeswitch_configuration.sql` adds the singleton
`inbound_freeswitch_configuration`. Number/queue edits invalidate verification and
advance `desired_revision`; the existing B01 per-entity revisions remain intact.
The snapshot includes the number/queue identity and revisions, original DID,
queue timeout, trusted CIDRs, hard guard policy and renderer templates. A policy
or binary/template change also advances the desired revision through its hash.
No caller-supplied SIP header becomes product authority. UUID and route metadata
are set only inside the trusted route; a SIP answer is never an admission receipt.

`InboundConfigurationPublisher` acquires session advisory lock `(72204, 0)` with
nonblocking `pg_try_advisory_lock`. A competing publisher returns `busy` and retries
on its next tick. BEFORE STATEMENT triggers take the same transaction lock before
number/queue row locks, so a committed edit either precedes the snapshot or waits
until the current publish completes. The publisher never acquires call admission,
execution or user media locks, and holds no SQL transaction while sending ESL.
Configuration editors must acquire this configuration lock **before** any explicit
number/queue row lock. Do not call this publisher from a call-admission transaction.

The publisher validates finite typed values and parses the XML with `saxes`,
rejecting DOCTYPE. It writes and fsyncs a same-directory temporary file, renames
and fsyncs the directory, then runs `reloadxml`. Success also requires an actual
`xml_locate dialplan context name public` response with exactly the expected bundle
marker. An ACK or saved SQL row alone cannot set `applied_revision`.

The complete bundle is published at
`FREESWITCH_GENERATED_CONFIG_DIR/dialplan/public/00-inbound.xml`. On verification
success it is saved as `inbound/last-good.xml`, and the singleton plus number/queue
applied revisions are committed together. Failures retain the last applied revision,
set `error_revision`/`apply_error` and clear `verified_at`. If disk or FS was changed,
rollback restores last-good, reloads and checks its effective marker. A failed rollback
is explicitly reported as uncertain. It must not be interpreted as successful apply.
No API error includes credentials; no credentials are present in these XML bundles.

The API runs reconciliation at startup and every 30 seconds only when configured
and ESL is enabled. Every reconciliation checks the real configuration again,
including after API or FS restart. The FS entrypoint restores only last-good before
starting SIP, discarding an interrupted candidate; with the feature flag off it
publishes the deny bundle instead. All replicas must use the same binary, policy,
DB and shared generated-config volume for this single-FS deployment. This is not a
multi-host/distributed filesystem publisher. The actual writer runs under OS `flock` (the API image installs `util-linux`).
A lost DB session stops further apply steps, and the replacement publisher remains
busy until the old lock-owning writer exits. A suspended parent cannot perform
filesystem writes after replacement: only the lock-owning process writes files.
Locks are never stolen by TTL/mtime; parent exit closes stdin and the writer drains
its pending write before exiting. Losing the writer also removes the old parent's
ability to mutate files. This deliberately trades availability during a suspended
writer for correctness; terminate the suspended parent/writer before retrying.

## Physical safeguards and routing

The entrypoint now owns the entire `public` and `agent-ingress` context wrappers.
Vanilla public extensions cannot run before the trust check. The authenticated
browser context always rejects client INVITEs (`403 Backend call control required`)
and contains no PSTN originate/bridge action. A04/D01 still own session-specific
credentials and authoritative `sofia_contact` pinning; this change uses their existing
generated directory rather than a shared agent registration flag.

Trust uses the actual channel `network_addr` against a finite list of literal
IPv4/IPv6 CIDRs. Empty lists, `/0`, malformed input and XML/ESL injection are rejected.
This is transport peer trust, so any SIP proxy must be included only after I04's
actual trust review. No provider CIDR is inferred from the local fixtures. DID
normalization is deliberately limited to the configured canonical digits with an
optional leading `+`; provider-specific delivery rules require I04 evidence.
Untrusted, disabled and unknown routes return 403, 403 and 404 respectively.

Enabled routes acquire native `mod_hash` limits in realm `outbound_dialer`, resources
`pre_admission` and `trunk`, before the continuation. They set `limit_ignore_transfer`,
`sched_hangup` and `park_timeout`. Until D03 exists the continuation refuses immediately;
the scheduled guard is additional protection, not evidence that an indefinite blocking
script can be interrupted. D03 must bound each capture/ack I/O by A03's separate-process
protocol and must not perform direct FreeSWITCH SQLite writes. It releases the
pre-admission permit only after DB admission commits, and preserves the customer/trunk
permit until physical termination. New outbound/forward adapters must use the same
physical trunk counter before external originate; the D02 ingress test does not prove
that later adapters or legacy outbound paths already use it. I05 must verify shared
physical counters and C02/FS headroom across every enabled sender before activation.

Core `max-sessions` and `sessions-per-second` apply before dialplan scripts. Lowering
a guard refuses new work and does not hang up existing sessions. Runtime guard changes
remain deployment operations; `reloadxml` alone does not reconfigure core settings.
Default values match A06 (80 physical sessions, 40 external legs, 8 pre-admission).
Deployment must align C02 `calls.capacity_limits` with these guards, including
`channels + preAdmission <= fsChannels` and `trunk + preAdmission <= fsTrunk`.
No journal/history receipt exists for rejected pre-admission calls. Do not promise
complete rejected-attempt history. Native hash counters are FS-process local and
reset on FS restart; DB uncertainty is never released merely because they reset.

## Configuration and verification

Use `.env.example`, the existing Compose model and `scripts/deploy.sh`. No host
ports, firewall rules or parallel deployment path were added. The API image includes
the inbound templates, and the FS image already includes the template tree.

| Variable                                 | Default / allowed values                                         | Consumer                             |
| ---------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| `FREESWITCH_INBOUND_CONFIG_ENABLED`      | `false`; exactly `true` or `false`                               | API publisher and FS startup restore |
| `FREESWITCH_INBOUND_TRUSTED_CIDRS`       | empty; 1–32 comma-separated literal CIDRs required when applying | API renderer                         |
| `FREESWITCH_INBOUND_PRE_ADMISSION_LIMIT` | `8`; 1–16 channels                                               | API renderer, native hash guard      |
| `FREESWITCH_TRUNK_CHANNEL_LIMIT`         | `40`; 2–80 external legs                                         | API renderer, native hash guard      |
| `FREESWITCH_INBOUND_WAIT_SECONDS`        | `3`; 1–3 seconds                                                 | API renderer                         |
| `FREESWITCH_MAX_SESSIONS`                | `80`; 16–200 channels                                            | FS core at startup                   |
| `FREESWITCH_SESSIONS_PER_SECOND`         | `20`; 1–100 new sessions/s                                       | FS core at startup                   |

Run with Node 22:

```bash
npm run test:inbound:db:isolated
npm run test:config:freeswitch
npm run quality
APP_ENV_FILE="$(pwd)/.env.example" docker compose --env-file .env.example \
  -f infra/docker/docker-compose.yml config --quiet
git diff --check
```

The FS runner uses the **product entrypoint and templates**, the pinned FS digest,
network-isolated PostgreSQL and authenticated UDP/PCMU fixtures. It never reads `.env`
or `DATABASE_URL`, publishes no ports and destroys only its own containers. Artifacts
under `/tmp/outbound-d02.*` retain source hashes, versions, commands, protocol results,
report and teardown. DB races use separate connections and `pg_blocking_pids`, both
commit orders and rollback. FS capacity fixtures explicitly pin native counters to live
channels to establish the full boundary without timing races; they do not simulate a
D03 durable admission. Audio preservation requires a real bridge and decoded tone.

Actual commands/results and any failed or omitted gates are recorded in issue #22.
Local UDP/PCMU evidence does not establish browser WebRTC, hosted CI, provider source,
caller ID, early/far-end audio, billing, deployment, load/soak, rollback-binary or
production acceptance. Those retain their owning backlog tasks.
