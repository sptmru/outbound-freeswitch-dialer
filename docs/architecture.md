# Architecture

## System Model

The implemented system is a backend-controlled, single-tenant outbound dialer. The browser is an authenticated agent media endpoint; it never owns PSTN routing or destination authorization. Fastify and FreeSWITCH coordinate call control through ESL, while PostgreSQL is the durable source of product state and event history.

```text
Browser (React + SIP.js)
  | HTTPS REST, credentialed SSE, WSS SIP
  v
nginx proxy --------------------------+
  |                                   |
  v                                   v
Fastify API <---- ESL ------------ FreeSWITCH ---- SIP trunk ---- PSTN
  |                                   |
  +---- PostgreSQL                    +---- recordings storage
  +---- ffmpeg/ffprobe
  +---- Prometheus metrics/logs
```

The deployment is a single-host Docker Compose topology. FreeSWITCH uses host networking for media/SIP constraints; application, database, proxy, and monitoring services use the Compose network. Firewall policy and host-port changes are outside the current implementation scope and require a separate deployment review.

## Components

### Web application

- React/Vite agent and administrator UI.
- SIP.js softphone registration over WSS, started only on Agent Desk.
- Credentialed REST calls and `EventSource` subscription to `/agent/events`.
- Periodic HTTP refresh remains as fallback because SSE carries invalidation hints, not full state.
- No browser persistence of the session JWT and no JWT-bearing audio URLs.

### Fastify API

- Authentication, role authorization, cookie CSRF protection, login rate limiting, and safe proxy handling.
- Campaign/contact selection, suppression checks, manual validation, and user/admin workflows.
- ESL originate, bridge, DTMF, hangup, voicemail transfer, event processing, recording startup, and reconciliation. Incoming events use a bounded ordered queue with exponential retry for transient PostgreSQL failures; overflow disconnects the listener and is surfaced through metrics instead of being silently ignored.
- Call/leg/event persistence and automatic outcome/contact lifecycle.
- Voicemail transcoding, media ticket issuance, and byte-range streaming.
- Live-event fan-out, audit capture, retention scheduling, metrics, health, and readiness.

### PostgreSQL

- Durable users, agents, campaigns, contacts/imports, calls, legs, events, recordings, suppression, settings, media tickets, and audit events.
- Transactional row locks and unique indexes protect active-call/contact ownership.
- Constraints bound core statuses/outcomes and credential/session versions.
- Statement-level triggers call `pg_notify('outbound_dialer_changes', ...)`; the API publishes a refresh SSE event to connected authenticated clients.
- PostgreSQL advisory locks serialize migrations and retention work.

### FreeSWITCH

- Internal WebRTC SIP profile and WSS media endpoint for browser agents.
- Provider-neutral external trunk in registration or IP-auth mode.
- Agent-first originate/bridge controlled by ESL.
- Application-owned dialplan for voicemail playback and custom lifecycle events.
- Call recording, early-media AVMD, DTMF, channel state, and UUID existence checks.
- Active calls are reconciled after each subscription and periodically. Requests are coalesced and wait for the event persistence backlog to drain; readiness requires the long-lived event subscription, not only a successful one-off ESL command.

### Operational services

- nginx proxy and automated Let's Encrypt certificate jobs.
- Prometheus, Grafana, Alertmanager, Loki, Alloy, exporters, and blackbox checks.
- PostgreSQL metrics use the independent `outbound_dialer_exporter` login with `pg_monitor`, read-only transactions, and no application-table grants; deploy/restore rotate it from `POSTGRES_EXPORTER_PASSWORD` after database changes.
- Monitoring files are release-gated with the validators embedded in the exact Prometheus, Alertmanager, Blackbox Exporter, Loki, and Alloy images before services are changed.
- Authenticated backup/verification/restore scripts and SHA-tagged deploy/rollback scripts.

## Authentication And Request Security

1. `POST /auth/login` verifies the local password and active account.
2. The API signs an expiring token containing user ID, role, email, and `auth_version`.
3. The browser receives it in the HttpOnly `outbound_dialer_session` cookie. The response also includes the token for explicit non-browser Bearer compatibility; the web client ignores and does not store it.
4. `requireUser` accepts a Bearer token first or the session cookie, verifies signature/expiry, reloads the user, and rejects inactive or stale `auth_version` sessions.
5. Unsafe cookie-authenticated requests require an allowed `Origin`. Explicit Bearer requests bypass the ambient-cookie CSRF rule.
6. Logout clears the cookie. Password resets and deactivation increment `auth_version` to revoke outstanding sessions.

The production cookie is `Secure`, `HttpOnly`, `SameSite=Strict`, and path `/`. CORS uses an explicit origin list and credentials. Forwarded client addresses are accepted only when the direct peer is loopback/private/link-local.

## Live Update Flow

1. An authenticated browser opens `GET /agent/events` with credentials.
2. The API sends a `ready` event, `retry: 3000`, and a heartbeat comment every 15 seconds.
3. Inserts/updates/deletes on product tables trigger PostgreSQL `NOTIFY`.
4. A dedicated API listener publishes a small `refresh` event containing source and time.
5. The browser debounces and refetches authoritative REST state.
6. Native EventSource reconnect handles transient network failures. The DB listener reconnects after failure, and periodic HTTP refresh covers blocked/unsupported SSE.

This design avoids maintaining per-user product snapshots in the SSE layer. Authorization and complete state continue to be enforced on the REST endpoints.

## Outbound Call Flow

1. Agent selects an active campaign contact or submits a manual number.
2. The API verifies the authenticated agent, campaign flags, SIP registration/readiness, normalized destination, and suppression status.
3. Inside a transaction, the API locks the agent and contact, rejects another interactive call, enforces retry age/attempts, creates call/leg/event rows, increments the contact attempt, and marks the agent in call.
4. The API reserves FreeSWITCH UUIDs and sends an agent-first background originate.
5. The browser answers its internal SIP leg. FreeSWITCH originates the customer leg through the configured trunk and bridges both legs.
6. ESL events update leg state, call state, answer timestamps, recording/AVMD status, hangup cause, automatic outcome, contact status, and agent availability.
7. The originate watchdog and reconnect reconciliation close missing calls rather than leaving durable state stuck.

Contact selection uses `FOR UPDATE SKIP LOCKED`; database uniqueness also prevents two active claims for one agent/contact. Defaults allow three attempts with a 15-minute delay between retryable attempts.

## Voicemail Drop Flow

```text
bridged
  -> voicemail_drop_requested
  -> voicemail_playback_started
  -> agent_released
  -> completed (voicemail_dropped)
       or failed/interrupted terminal outcome
```

1. The API checks that the call/customer UUID/recording/action are eligible.
2. A transaction conditionally moves the call to `voicemail_drop_requested`; a repeated/concurrent request cannot claim it twice.
3. ESL transfers the customer channel into the application-owned voicemail dialplan.
4. FreeSWITCH emits a custom playback-start event before playing canonical audio.
5. The API records `voicemail_playback_started`, asks FreeSWITCH to kill only the agent leg, and records `agent_released` only after confirmation or an already-absent-channel response.
6. The agent becomes available for a new interactive call while the original customer leg remains visible as a background job.
7. FreeSWITCH emits custom completion/failure evidence, while customer-channel terminal events classify interruption/hangup. Completion closes the call/contact as `voicemail_dropped`; incomplete playback records its technical event and terminal outcome.
8. After ESL reconnect, the API checks customer/agent UUIDs. A live playback continues; an unconfirmed missing customer channel is finalized as incomplete rather than falsely successful.

The event record is the source of lifecycle evidence. A local completion event still does not prove the remote mailbox recorded the entire message; production acceptance requires far-end verification.

## Recording And Media Flow

### Voicemail upload

1. Admin submits one WAV/MP3 (the configurable multipart limit defaults to 64 MiB, with separate proxy overhead allowance).
2. The API writes a temporary source, runs ffprobe, rejects invalid/no-audio/over-five-minute input, and invokes ffmpeg.
3. Output is normalized to mono, 8,000 Hz, `pcm_s16le` WAV with `loudnorm=I=-16:TP=-1.5:LRA=11`.
4. Only a non-empty, successfully probed canonical file is persisted and activated in PostgreSQL.
5. Exactly one global recording may be default; deleting/deactivating the default promotes another active recording when present.

### Browser playback

1. An authorized admin requests a media ticket for one voicemail or call recording.
2. The API generates an opaque token, stores only its SHA-256 hash with user/resource/route/expiry, and returns the short-lived URL.
3. The audio endpoint accepts either the admin session or the matching ticket, verifies the active user and scope, and streams the file.
4. Valid single byte ranges return partial content for seeking. Invalid/missing/empty files do not return misleading success.

## Campaign, User, Suppression, And Audit Model

- Campaigns use `draft`, `active`, `paused`, and `archived`; only active campaigns are callable.
- Contacts retain attempt count/time and move among new/calling/completed/suppressed states according to lifecycle.
- Users are deactivated, not physically deleted, so historical call/audit attribution remains available. Deactivation revokes sessions and agent registration material.
- Suppression entries store the current block; `suppression_events` preserve create/update/import/remove/blocked-manual-dial evidence.
- A Fastify hook records every successful mutating `/admin/*` request in `admin_audit_events`. It stores identifiers and bounded string route parameters, not request bodies/secrets.

## Retention Architecture

- The scheduler runs once at API startup and then on `RETENTION_RUN_INTERVAL_SECONDS` while `RETENTION_ENABLED=true`.
- An in-process flag avoids overlap and a PostgreSQL advisory lock avoids cross-instance overlap.
- Terminal calls without recording metadata are deleted after `CALL_LOG_RETENTION_DAYS`.
- Calls with recordings remain until `CALL_RECORDING_RETENTION_DAYS`; then the file is unlinked first.
- Successful unlink or `ENOENT` clears recording metadata in a transaction, after which call retention may delete the row.
- Any other unlink error leaves metadata and the call row intact and emits an error/retention-failure signal for retry.
- Manual admin execution uses the same policy and supports dry-run counts.

Retention does not implement legal hold. Audit retention and legal-hold rules require an external policy before production acceptance.

## Backup, Restore, And Rollback

- Backup refuses active calls and briefly quiesces the API/FreeSWITCH writers while capturing the PostgreSQL dump and recordings archive. It packages those with metadata into an `ODBACKUP2` AES-256-GCM envelope. A scrypt-derived key, random salt/IV, authenticated header, and GCM tag detect wrong secrets and tampering. The local archive is self-verified before upload or success-metric publication.
- Verification authenticates/decrypts first, validates archives, and checks `pg_restore --list`.
- Deploy, restore, and rollback atomically record a pending target before changing the runtime; only a successful health/smoke sequence promotes it to `CURRENT_VERSION`.
- Restore stops API/FreeSWITCH, uses `pg_restore --clean --if-exists --single-transaction`, snapshots recordings before replacement, restarts with health waits, runs the web smoke test, records the restored SHA, and reinstalls backup/certificate cron jobs.
- Application rollback reuses retained SHA-tagged images. It does not reverse forward-only migrations.
- SIP secrets remain dual-readable. First deploy with `v1` writes and the independent key present; only a later deploy enables `v2` writes/migration after confirming the previous image is a safe dual-read rollback target.

## Trust And Acceptance Boundaries

- The database/API can confirm requested commands, observed FreeSWITCH events, and local media lifecycle; only external tests can confirm provider/customer behavior.
- Same-host monitoring cannot detect complete host/network loss; production needs an off-host probe.
- Backup code does not prove off-host delivery or RPO/RTO; a clean-host drill must supply evidence.
- Retry defaults are technical defaults, not legal approval.
- Firewall rules and host-port changes are not implemented by this scope and must be reviewed independently.
