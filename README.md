# Outbound Dialer

Single-tenant outbound dialer with a browser softphone, backend-owned call control, FreeSWITCH ESL, PostgreSQL, React, Fastify, TypeScript, and Docker Compose.

The repository now contains the planned operational MVP: agent calling, manual voicemail drop with agent release, campaign/contact administration, suppression, recordings, history, audit, monitoring, retention, deployment, backup, restore, and rollback tooling. Repository implementation and automated checks are not a substitute for production acceptance; SIP-provider integration, real external calls/mailboxes, compliance decisions, and operational drills remain open.

## Implemented Product Surface

- Agent Desk with SIP.js registration over WSS, campaign leads, manual dialing, DTMF, backend-owned call controls, automatic outcomes, and background voicemail jobs.
- Event-driven voicemail lifecycle: `voicemail_drop_requested`, `voicemail_playback_started`, `agent_released`, and terminal completed/failed/interrupted events. Active calls are reconciled against FreeSWITCH after ESL reconnect.
- Retry-safe contact selection with row locking, three attempts and a 15-minute retry delay by default (`CONTACT_MAX_ATTEMPTS=3`, `CONTACT_RETRY_DELAY_SECONDS=900`).
- Campaign create/edit/pause/archive, narrow `name` + `phone` CSV import with paginated failure review, paginated contact search/status, and suppression checks before originate.
- Admin user lifecycle with edit, deactivate/reactivate, password reset, session revocation, preserved historical attribution, and administrative mutation audit.
- Paginated/filterable call history, detail timelines with explicit truncation status, bounded CSV export, call-recording playback, suppression search/import/removal, and suppression event history.
- Dedicated admin Analytics with date/campaign filters, business KPIs, AVMD review evidence, per-leg RTP quality coverage, codec/provider breakdowns, and telephony reconciliation/finalization reporting.
- WAV/MP3 voicemail uploads transcoded by ffmpeg to mono 8 kHz signed 16-bit PCM WAV with loudness normalization and a five-minute limit.
- HttpOnly `SameSite=Strict` browser session cookie, Origin-based CSRF protection for cookie-authenticated mutations, login rate limiting, and Bearer compatibility for non-browser API clients.
- Credentialed SSE at `GET /agent/events`, backed by PostgreSQL notifications, browser reconnect, and periodic HTTP fallback refresh.
- Short-lived, scoped, hashed media tickets and HTTP byte-range streaming. Browser media URLs do not contain the session JWT.
- Scheduled call/recording retention with PostgreSQL advisory locking, metrics, dry-run/manual execution, and failure-safe recording deletion.
- Prometheus/Grafana/Loki/Alertmanager monitoring, guarded SHA-tagged deployment/rollback, authenticated encrypted backups, and transactional database restore.

## Status And Acceptance

The source-backed implementation status is maintained in:

- [Implementation status and remaining work](docs/implementation-plan.md)
- [Production acceptance checklist](docs/acceptance-checklist.md)
- [Known limitations](docs/known-limitations.md)
- [External decisions still open](docs/open-questions.md)

No document in this repository should be read as proof that a live provider call, far-end voicemail recording, clean-host restore, load/soak target, or client handover has passed. Those items require recorded evidence from the target environment.

Firewall policy and changes to host-published ports were intentionally excluded from this implementation pass. The current Compose network/port shape remains unchanged and must be reviewed by the deployment owner before production acceptance.

## Documentation

- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Environment configuration](docs/environment-configuration.md)
- [Design plan](docs/design-plan.md)
- [Agent guide](docs/agent-guide.md)
- [Administrator guide](docs/admin-guide.md)
- [Deployment and rollback](docs/runbooks/deployment.md)
- [Backup and restore](docs/runbooks/backup-restore.md)
- [Incident response](docs/runbooks/incident-response.md)
- [SIP/RTP capture](docs/runbooks/pcap.md)
- [AWS NAT, firewall, STUN, and TURN](docs/runbooks/aws-networking.md)
- [AI development workflow](docs/ai-development-workflow.md)
- [Architecture decisions](docs/adr/0001-initial-architecture.md)

## Repository Shape

```text
apps/api/                 Fastify API, PostgreSQL migrations, ESL orchestration
apps/web/                 React/Vite agent and administrator UI
packages/shared/          Shared TypeScript contracts
infra/docker/             Compose deployment and container configuration
infra/freeswitch/         Runtime templates, dialplans, and recordings mount
infra/coturn/             TURN server runtime entrypoint
infra/pcap/               Capability-scoped packet-capture sidecar
infra/proxy/              Public nginx/TLS/WSS gateway
infra/fail2ban/           Host-network SIP scanner blocking
monitoring/               Metrics, dashboards, alerts, and log collection
scripts/                  Quality, deployment, backup, restore, and smoke tooling
docs/                     Requirements, status, guides, ADRs, and runbooks
```

## Local Validation

Node.js 22 or newer is required.

```bash
npm ci
npm run quality
```

`npm run quality` runs lint, formatting checks, TypeScript checks, workspace tests, and production builds. Additional environment-backed checks are separate:

```bash
npm run test:e2e
npm run test:freeswitch
npm run test:load:desk
```

Authenticated administrators can open the complete OpenAPI 3.1 documentation at `/api/docs/`; the JSON document is available at `/api/docs/json`. Shared TypeScript response contracts are converted into OpenAPI components and checked for drift by `npm run quality`. After changing an exported contract, regenerate the checked-in components with:

```bash
npm --workspace @outbound-dialer/api run openapi:generate
```

Validate the Compose model with example values:

```bash
APP_ENV_FILE="$(pwd)/.env.example" docker compose --env-file .env.example -f infra/docker/docker-compose.yml config
```

## Deployment

Create `.env`, replace every placeholder, keep it mode `0600`, and follow the deployment runbook:

```bash
cp .env.example .env
chmod 600 .env
./scripts/preflight.sh
./scripts/deploy.sh
```

Production preflight requires strong independent secrets (including `POSTGRES_EXPORTER_PASSWORD`), a pinned FreeSWITCH image, TLS/Grafana domains, an alert receiver or explicit exception, and an off-host backup destination or explicit local-only risk acceptance. Deploy/restore validate each monitoring config with its runtime binary and configure the exporter through a dedicated read-only PostgreSQL role.

SIP credential encryption must use the two-stage `v1` to `v2` procedure in the [deployment runbook](docs/runbooks/deployment.md#two-stage-sip-credential-encryption-rollout). Do not enable `v2` writes until the immediately previous rollback image is confirmed to support dual reads.

Health endpoints:

```text
GET /health/live
GET /health/ready
GET /health
```

Readiness includes PostgreSQL, a one-off ESL command, and the long-lived FreeSWITCH event subscription. ESL persistence backlog/retries/overflows are exported to Prometheus; periodic active-call reconciliation is coalesced behind the ordered event queue.

The public UI and API normally share one HTTPS origin:

```text
https://<LETSENCRYPT_DOMAIN>
https://<LETSENCRYPT_DOMAIN>/api/*
```

Grafana is exposed through its configured HTTPS hostname. Prometheus, Loki, Alertmanager, and exporters stay on the private Compose network.

## Backup, Retention, And Recovery

`scripts/backup.sh` creates an `ODBACKUP2` AES-256-GCM authenticated envelope containing a PostgreSQL custom-format dump, voicemail/call recordings, and source metadata, then self-verifies it before upload or success-metric publication. `scripts/verify-backup.sh` is also available for independent checks. `scripts/restore.sh` requires an explicit confirmation, exact/approved-compatible release provenance, restores PostgreSQL with `--single-transaction`, snapshots existing recordings, runs the web smoke check, records stable deployment state, and reinstalls backup/certificate cron jobs.

Default application retention is:

```text
CALL_LOG_RETENTION_DAYS=7
CALL_RECORDING_RETENTION_DAYS=30
RETENTION_RUN_INTERVAL_SECONDS=86400
```

Calls that still reference a recording are retained until the recording becomes eligible. Recording metadata is cleared only after the file is deleted or confirmed absent; other unlink failures preserve both metadata and the call row for a later retry.

See the [backup/restore runbook](docs/runbooks/backup-restore.md) and exercise it on an isolated host before declaring recovery accepted.
