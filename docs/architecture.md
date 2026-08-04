# Architecture

## System Model

The implemented system is a backend-controlled, single-tenant outbound dialer. The browser is an authenticated agent media endpoint; it never owns PSTN routing or destination authorization. Fastify and FreeSWITCH coordinate call control through ESL, while PostgreSQL is the durable source of product state and event history.

```text
Internet
  |
  +-- HTTPS / REST / SSE -----------------------------+
  +-- WSS SIP (/freeswitch-ws) -------------------+   |
  +-- TURN/TURNS ------------------------------+  |   |
                                               |  |   v
Browser (React + SIP.js)                       |  +-> nginx proxy
  |                                            |        |-- web (React/Vite)
  | short-lived ICE credentials                |        |-- api (Fastify)
  +---------------------------------------------+        |-- Grafana
                                               v        +-- FreeSWITCH WSS
                                             Coturn

Fastify API <---- ESL --------------------> FreeSWITCH ---- SIP trunk ---- PSTN
  |                                            |
  +---- PostgreSQL                             +---- recordings storage
  +---- ffmpeg/ffprobe                         +---- SIP/RTP media
  +---- pcap-capture control socket                  |
  +---- /metrics                                     +-- pcap-capture

Prometheus <---- API/exporters/blackbox       Alloy ----> Loki
    |                                            Docker and FreeSWITCH logs
    +----> Alertmanager
    +----> Grafana <---- Loki
```

The deployment is a single-host Docker Compose topology. FreeSWITCH, Coturn, the packet-capture service, and fail2ban use host networking because they inspect, advertise, or protect host SIP/RTP/TURN traffic. Application, database, proxy, and monitoring services use the default Compose network. Alloy alone also joins an internal `docker-monitoring` network to reach a read-only Docker socket proxy. Firewall policy and host-port changes are outside the current implementation scope and require a separate deployment review.

Only nginx is intended as the public HTTP entrypoint. Grafana is routed by hostname through the same proxy and certificate flow; Prometheus, Loki, Alertmanager, and exporters have no published ports. The current Compose file also publishes direct API and web ports for operational compatibility, so the deployment owner must restrict those host ports before production acceptance.

## Components

### Web application

- React/Vite agent and administrator UI.
- SIP.js agent softphone registration over WSS, started only on Agent Desk. A separate admin supervisor softphone exists only on **Live calls**; listen-only answers use receive-only audio constraints and microphone capture begins only for whisper/join.
- Agent Desk keeps audio-device and microphone-processing preferences in browser storage. The selected input is passed into SIP.js capture constraints, the selected output is applied with the browser `setSinkId` capability when available, and the readiness check analyzes a short local microphone sample plus ICE candidate gathering without persisting raw audio.
- Credentialed REST calls and `EventSource` subscription to `/agent/events`.
- Periodic HTTP refresh remains as fallback because SSE carries invalidation hints, not full state.
- No browser persistence of the session JWT and no JWT-bearing audio URLs.

### Fastify API

The API publishes an admin-only Swagger UI at `/api/docs/` through the application proxy. The OpenAPI 3.1 document at `/api/docs/json` covers every registered route with path/query parameters, request bodies, success responses, error responses, and Bearer/session-cookie authentication. Shared response components are generated from `packages/shared/src/index.ts`; `npm run quality` rejects stale generated schemas or a registered route without a detailed operation contract.

- Authentication, role authorization, cookie CSRF protection, login rate limiting, and safe proxy handling.
- Campaign/contact selection, suppression checks, manual validation, and user/admin workflows.
- Read-only admin analytics aggregate bounded date/campaign queries from PostgreSQL. Period facts and current contact-queue snapshots are returned as distinct sections so the UI does not imply historical snapshots that were never stored. AVMD quality is joined to explicit `call_avmd_reviews`; FreeSWITCH RTP quality comes from per-leg `call_media_stats`; browser playout and microphone evidence comes from the agent-owned `call_browser_media_stats`; point-in-time drift comes from the singleton `telephony_observability_state`.
- ESL originate, bridge, DTMF, hangup, voicemail transfer, event processing, recording startup, and reconciliation. Incoming events use a bounded ordered queue with exponential retry for transient PostgreSQL failures; overflow disconnects the listener and is surfaced through metrics instead of being silently ignored.
- Call/leg/event persistence and automatic outcome/contact lifecycle.
- Voicemail transcoding, media ticket issuance, and byte-range streaming.
- Live-event fan-out, audit capture, retention scheduling, metrics, health, and readiness.

### PostgreSQL

- Durable users, agents, campaigns, contacts/imports, calls, legs, events, recordings, suppression, settings, media tickets, supervisor endpoints/sessions, and audit events.
- Transactional row locks and unique indexes protect active-call/contact ownership.
- Constraints bound core statuses/outcomes and credential/session versions.
- Statement-level triggers call `pg_notify('outbound_dialer_changes', ...)`; the API publishes a refresh SSE event to connected authenticated clients.
- PostgreSQL advisory locks serialize migrations and retention work.

### FreeSWITCH

- Internal WebRTC SIP profile and WSS media endpoint for browser agents.
- Provider-neutral external trunk in registration or IP-auth mode.
- Agent-first originate/bridge controlled by ESL.
- A separate backend-originated `eavesdrop` leg for admin listen/agent-whisper/two-party-join modes. Browser DTMF cannot change mode; the API replaces the leg with explicit FreeSWITCH variables.
- Application-owned dialplan for voicemail playback and custom lifecycle events.
- Call recording, early-media AVMD, DTMF, channel state, and UUID existence checks.
- Active calls are reconciled after each subscription and periodically. Requests are coalesced and wait for the event persistence backlog to drain; readiness requires the long-lived event subscription, not only a successful one-off ESL command.

### Operational services

- nginx proxy and automated Let's Encrypt certificate jobs.
- Coturn on host networking, using short-lived HMAC credentials issued by the API. It binds TURN/TURNS plus a dedicated relay range and supports both directly addressed hosts and public/private NAT mappings.
- A capability-scoped `pcap-capture` sidecar receives per-call capture commands through a Unix socket shared with the API. It starts a broad temporary capture before originate, then filters it at the terminal transition using SIP `Call-ID` and exact local media ports derived from persisted ESL events. The broad temporary file is deleted even when isolation fails. Capture is disabled by default, stored in a private named volume, retention-bound, and exposed to administrators only through scoped media tickets.
- fail2ban tails the shared FreeSWITCH log volume and installs host firewall bans for the repository-defined SIP scanner filter.
- Prometheus, Grafana, Alertmanager, Loki, Alloy, exporters, and blackbox checks.
- Application metrics keep label cardinality bounded; product dimensions that grow with history stay in PostgreSQL-backed admin analytics rather than Prometheus labels.
- `CHANNEL_HANGUP_COMPLETE` is the durable per-leg source for final FreeSWITCH RTP counters, MOS, jitter, codecs, and SIP gateway/profile. Media rows upsert on `(call_id, leg_type)` so ESL retries are idempotent. Terminal latency uses the FreeSWITCH microsecond event timestamp and the same guarded database update that wins terminal state.
- The internal agent INVITE carries `X-Outbound-Dialer-Call-ID`; SIP.js uses it to bind `RTCPeerConnection.getStats()` to the durable call without relying on UI timing. The browser samples every five seconds, uploads a cumulative summary every thirty seconds and on termination, and the API accepts it only when the authenticated user owns the call. The browser requests mono capture with echo cancellation, noise suppression, and automatic gain control, then records the settings actually applied by the device/browser.
- PostgreSQL metrics use the independent `outbound_dialer_exporter` login with `pg_monitor`, read-only transactions, and no application-table grants; deploy/restore rotate it from `POSTGRES_EXPORTER_PASSWORD` after database changes.
- Monitoring files are release-gated with the validators embedded in the exact Prometheus, Alertmanager, Blackbox Exporter, Loki, and Alloy images before services are changed.
- Alloy discovers only containers from `COMPOSE_PROJECT_NAME`, reads FreeSWITCH and deployment logs, and sends them to Loki through the private Compose network. It reaches read-only container and network metadata through a verb-disabled socket proxy rather than mounting the Docker socket directly; network metadata is required for Docker discovery even though Alloy does not use it to mutate Docker networking.
- Authenticated backup/verification/restore scripts and SHA-tagged deploy/rollback scripts.

### Compose service inventory

| Responsibility  | Services                                                                                                       | Network/storage notes                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Product runtime | `postgres`, `api`, `web`, `proxy`                                                                              | Default Compose network; PostgreSQL and generated FreeSWITCH config use named volumes.                  |
| Telephony/media | `freeswitch`, `coturn`, `pcap-capture`, `fail2ban`                                                             | Host networking; recordings and FreeSWITCH logs are shared only with the services that need them.       |
| Metrics/alerts  | `prometheus`, `alertmanager`, `grafana`, `node-exporter`, `cadvisor`, `postgres-exporter`, `blackbox-exporter` | Internal service-to-service access; only Grafana is routed publicly through nginx.                      |
| Logs            | `alloy`, `loki`, `docker-socket-proxy`                                                                         | The socket proxy is isolated on `docker-monitoring`; Alloy bridges that network to the default network. |
| One-shot tools  | `certbot`, `monitoring-config`                                                                                 | Compose profile `tools`; started only by certificate/config rendering workflows.                        |

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
3. Inside a transaction, the API locks the agent and contact, rejects another interactive call, enforces retry age/attempts, resolves the agent Caller ID override with fallback to the current global trunk Caller ID, stores that effective value on the call, creates call/leg/event rows, increments the contact attempt, and marks the agent in call.
4. The browser starts a local ringback cue in the user-initiated call-start action while the API reserves FreeSWITCH UUIDs and sends an agent-first background originate. This removes silence during microphone and ICE setup without representing the cue as provider signaling.
5. The browser answers its internal SIP leg. The browser-local cue stops on the first unmuted remote media track, call-start failure, hangup, or softphone teardown. FreeSWITCH then originates the customer leg through the configured trunk and passes provider early media through. After a short grace period, the API refreshes and polls the customer leg's inbound RTP media-packet counter; while that counter is zero, it uses active `uuid_broadcast` playback to generate local ringback toward the agent even when the provider supplies no media frames. The API stops the playback with `uuid_break` as soon as callee RTP appears or the call answers/ends.
6. ESL events update leg state, call state, answer timestamps, recording/AVMD status, hangup cause, automatic outcome, contact status, and agent availability.
7. The originate watchdog and reconnect reconciliation close missing calls rather than leaving durable state stuck.

Contact selection uses `FOR UPDATE SKIP LOCKED`; database uniqueness also prevents two active claims for one agent/contact. Defaults allow three attempts with a 15-minute delay between retryable attempts.

## Supervisor Call Flow

1. The **Live calls** view provisions and registers a dedicated per-admin SIP identity. The identity uses the same deny-all authenticated browser ingress context as agents, so browsers cannot originate calls outside backend-owned ESL control.
2. `POST /admin/live-calls/:callId/supervisor` verifies admin authorization, registration, call ownership, bridged database state, and both live FreeSWITCH UUIDs. A transaction-scoped user lock serializes this against Agent Desk call creation.
3. The API inserts a `listen` session and originates a separate supervisor leg to `eavesdrop(<agent-leg-uuid>)`. The supervisor leg carries only supervisor correlation variables and is excluded from the normal call/leg finalizer.
4. FreeSWITCH enforces listen/whisper/join with `eavesdrop_bridge_*` and `eavesdrop_whisper_*`; `eavesdrop_enable_dtmf=false` prevents the browser from escalating itself.
5. Changing mode first stops the prior leg. Only after FreeSWITCH confirms that command does the API store a new UUID/mode and originate the replacement. A failure before that point leaves the prior mode authoritative; a replacement originate failure marks the new session failed.
6. ESL answer/bridge/hangup and background-job failure events update only the session whose current supervisor UUID/job UUID matches. Ending the supervisor leg never ends the agent/customer bridge.
7. Agent Desk refetches on `call_supervisor_sessions` notifications and shows the strongest active mode. Admin mutations receive normal request audit records enriched with the target call/session/mode.

The separate leg minimizes blast radius but does not prove what either party heard. Listen/whisper direction, join mixing, recording contents, reconnect behavior, and device permissions require a controlled target-environment call matrix before production acceptance.

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
4. After the transfer succeeds, the API asks FreeSWITCH to kill only the agent leg and records `agent_released` only after confirmation or an already-absent-channel response. Originate watchdogs treat the missing agent leg as intentional in voicemail background states.
5. The agent becomes available for a new interactive call while the original customer leg remains visible as a background job.
6. FreeSWITCH emits comma-delimited custom event headers for playback start and completion/failure evidence; the API persists those events by call/customer-leg ID.
7. Customer-channel terminal events classify interruption/hangup. Completion closes the call/contact as `voicemail_dropped`; incomplete playback records its technical event and terminal outcome.
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

Campaign bulk export uses a separate admin-only GET. The API verifies the campaign before sending headers, selects only `available` rows from that exact campaign, and accepts a file only when its database path exactly matches `CALL_RECORDINGS_STORAGE_DIR/<callId>.wav` and `lstat` reports a non-empty regular file. It then streams a store-mode ZIP with UUID-named WAV entries and a spreadsheet-safe manifest. Preflight skips are listed without raw paths; a retention unlink race aborts the stream rather than producing a misleading partial archive. The export start is written to the admin audit log with campaign and included/skipped counts.

## Campaign, User, Suppression, And Audit Model

- Campaigns use `draft`, `active`, `paused`, and `archived`; only active campaigns are callable.
- Contacts retain attempt count/time and move among new/calling/completed/suppressed states according to lifecycle.
- Users are deactivated, not physically deleted, so historical call/audit attribution remains available. Deactivation revokes sessions and agent registration material.
- Suppression entries store the current block; `suppression_events` preserve create/update/import/remove/blocked-manual-dial evidence.
- A Fastify hook records every successful mutating `/admin/*` request in `admin_audit_events`. The sensitive campaign-recording bulk GET writes its own export-start audit event. Audit records store identifiers and bounded metadata, not request bodies, phone numbers, storage paths, or secrets.
- Supervisor start/mode/stop audit entries are enriched with a bounded action, call/session identifier, and selected mode. SIP credentials and media are not placed in audit metadata.

## Runtime Administration Settings

- `.env` remains the bootstrap/default and deployment-secret source. An `admin.runtime_settings` JSON document in `system_settings` holds the validated admin override set.
- The API applies overrides to its shared live configuration after migrations and after `PATCH /admin/system-settings`; request-time dialing, normalization, export, caller-ID, PCAP, metrics, and retention consumers see the updated values immediately.
- The PCAP supervisor remains internally ready while the API policy controls whether a call creates capture state, so disabling capture does not require recreating the privileged sidecar.
- Alert destination credentials remain in the protected deployment environment. The UI can enable only channels whose credentials are present; the API atomically rewrites the mounted generated Alertmanager config, applies serialized generation-guarded reloads, and exposes pending/applied/failed status separately from settings persistence.

## Retention Architecture

- The scheduler remains alive at `RETENTION_RUN_INTERVAL_SECONDS`; each execution reads the current `RETENTION_ENABLED` and retention-window overrides.
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
