# Requirements

This document is the current product and operational contract. Items described as implemented are present in the repository; live-provider and production acceptance are tracked separately in [acceptance-checklist.md](acceptance-checklist.md).

## Product Boundary

- Single tenant.
- One interactive call per agent. A released voicemail customer leg may continue as a background job while the agent starts the next interactive call.
- Browser softphone for agent media; all PSTN origination and call control remain backend-owned through FreeSWITCH ESL.
- Local accounts with `agent` and `admin` roles. Admins may use Agent Desk, but SIP registration and microphone access start only while that view is open.
- Manual voicemail drop and automatically determined outcomes are the current product behavior. Progressive dialing, mandatory agent dispositions, and automatic voicemail drop are not part of this version.

## Authentication And Browser Security

- The browser authenticates with an HttpOnly session cookie named `outbound_dialer_session`.
- The cookie is `SameSite=Strict`, scoped to `/`, expires with `JWT_EXPIRES_SECONDS`, and is `Secure` in production.
- Cookie-authenticated unsafe methods require an `Origin` matching `PUBLIC_APP_URL` or `CORS_ORIGINS`.
- Bearer authentication remains supported for non-browser API clients and is not subject to ambient-cookie CSRF checks.
- The browser must not persist the JWT or place it in media URLs. The login response retains the token only for API-client compatibility.
- Login attempts are rate-limited per client IP. Defaults are 10 attempts per 300 seconds.
- Password reset and user deactivation increment `auth_version`, revoking existing sessions.
- Proxy-derived client addresses are trusted only from loopback/private/link-local peers.

## Live State Updates

- Authenticated clients subscribe to credentialed SSE at `GET /agent/events`.
- PostgreSQL statement-level notifications publish refresh hints for agent, call, campaign, contact, recording, suppression, and user changes.
- EventSource reconnects automatically; the server advertises a three-second retry and sends 15-second heartbeats.
- The UI retains periodic HTTP refresh as a fallback. SSE is a refresh signal, not the authoritative state payload; REST responses remain authoritative.

## Agent Availability

- Agent availability is independent from browser-phone registration. Agents use `available` and `paused`; legacy `wrap_up` rows are normalized to `available`.
- Agents and admins using Agent Desk can pause or resume themselves through `PATCH /agent/availability`; availability cannot be changed during an active interactive call.
- Paused agents cannot start campaign, lead, or manual calls. Ending a call or launching a voicemail drop returns the agent to `available` immediately; calls are always started manually.
- Confirmed voicemail agent release is immediately available for the next interactive call. A pause selected while background voicemail continues must remain paused when that background job later completes.

## Telephony

- Support provider-neutral SIP registration and IP-authenticated trunk modes through runtime configuration.
- Keep provider credentials and routing details out of the product UI.
- Browser SIP uses WSS. PSTN codec/routing behavior must be validated with the selected provider.
- Use a backend-owned, agent-first originate/bridge flow; the browser never receives authority to choose the PSTN endpoint.
- Store calls, legs, state-changing events, UUIDs, commands, hangup causes, and automatic outcomes required for diagnosis.
- Allow DTMF only when the backend reports the action eligible.
- Persist subscribed ESL events in arrival order through a bounded queue. Retry transient database failures with backoff; if the queue fills, disconnect/reconnect the listener and raise an observable overflow rather than silently discarding backlog.
- Reconcile unfinished database calls with FreeSWITCH `uuid_exists` after ESL subscription/reconnect and periodically. Missing calls are closed, orphaned agent legs are released when possible, and active voicemail playback is recovered or finalized.

## Contact Retry Policy

- Campaign contacts are selected transactionally with `FOR UPDATE SKIP LOCKED`.
- Suppressed, completed, currently calling, and exhausted contacts are not callable.
- `attempt_count` increments when a contact call is committed.
- The default maximum is `CONTACT_MAX_ATTEMPTS=3`.
- The default delay before a non-terminal contact becomes callable again is `CONTACT_RETRY_DELAY_SECONDS=900` (15 minutes).
- `answered`, `customer_hung_up`, `voicemail_detected`, and successful voicemail-drop outcomes complete the contact. Busy/no-answer/failure/cancel paths return it to the callable lifecycle until the configured attempt limit.
- The client must approve final outcome-specific retry policy, permitted calling windows, and timezone before production use.

## Voicemail Drop

- Agents manually request a drop only when the call is eligible and select a recording or use the global default.
- The request is claimed transactionally and must be idempotent under repeated/concurrent clicks.
- FreeSWITCH emits application-owned custom events for playback start, completion, and playback failure; customer-channel terminal events classify interruption/hangup.
- The database lifecycle distinguishes `voicemail_drop_requested`, `voicemail_playback_started`, `agent_released`, and terminal completion/failure/interruption.
- The agent leg is marked released only after playback has started and the release is confirmed (or the channel is already absent). The customer leg remains tracked until a terminal event.
- Successful playback produces `voicemail_dropped`; failure/interruption records a distinct technical event and appropriate automatic outcome.
- Reconnect reconciliation must not infer success merely from a local file or a previous transfer request.
- VM/beep detection is advisory and visible when available; it does not automatically trigger a drop.
- Production acceptance requires proof from representative external mailboxes. Local FreeSWITCH playback completion alone is insufficient.

## Voicemail And Call Recordings

- Admins can upload WAV or MP3 voicemail audio, choose a default, preview, and deactivate/delete a recording.
- Uploads are decoded and transcoded before activation to mono, 8 kHz, signed 16-bit PCM WAV with loudness normalization.
- Audio with no valid stream, unavailable processing, malformed content, or duration over five minutes is rejected.
- Call recording remains campaign-controlled and is started on the customer leg through FreeSWITCH.
- Media playback supports single byte ranges for browser seeking.
- Browser media access uses short-lived opaque tickets scoped to one user, resource type, resource ID, and route. Only ticket hashes are stored in PostgreSQL.
- Default ticket TTL is 60 seconds; renewal is bounded by `MEDIA_TICKET_MAX_LIFETIME_SECONDS`.
- Recording storage, consent, legal hold, and deletion rules require client approval before production acceptance.

## Campaigns, Contacts, And Suppression

- Campaign states are `draft`, `active`, `paused`, and `archived`.
- Admins can create/edit campaigns and configure manual dialing, call recording, and early-media AVMD per campaign.
- Archived campaigns preserve operational history and are not callable.
- Current contact import is intentionally limited to required `name` and `phone` columns. The importer normalizes numbers, reports row errors, and avoids duplicates.
- Manual numbers and campaign contacts both pass backend authorization and normalized suppression checks before originate.
- Suppression supports add/update, search, pagination, CSV import, and removal.
- Suppression changes and blocked manual-dial attempts create durable `suppression_events`.

## Users And Administrative Audit

- Admins can create, edit, deactivate/reactivate, change role, and reset passwords.
- Deactivation is rejected while the user has an active interactive call, revokes sessions, removes agent registration material, and preserves historical attribution.
- Successful mutating `/admin/*` requests create `admin_audit_events` with actor, request ID, method, route, response status, source IP, user agent, bounded string route parameters, and timestamp.
- Audit history is paginated and filterable by actor, method, and date.
- Audit/retention/legal-hold duration is an external policy decision; it must not be assumed from call-log retention.

## History And Reporting

- Admin call history is paginated and filterable by text, campaign, agent, outcome, date range, voicemail drop/signal, and recording availability.
- Call detail includes lifecycle events and technical identifiers needed for diagnosis.
- CSV export applies the same filters and refuses exports above `CALL_HISTORY_EXPORT_MAX_ROWS` (50,000 by default).
- Outcomes are derived from backend call events. Agents do not select a mandatory post-call disposition in this version.

## Retention

- Automatic retention is enabled by default and runs at API startup and then every `RETENTION_RUN_INTERVAL_SECONDS` (86,400 seconds by default).
- PostgreSQL advisory locking prevents two API instances from performing the same retention run concurrently.
- Default call-log retention is seven days; default call-recording retention is 30 days.
- Only terminal `completed`, `failed`, and `canceled` calls are eligible.
- A call with recording metadata is retained until the recording reaches its own retention age.
- Recording metadata is cleared only after unlink succeeds or the file is confirmed absent. Any other unlink failure preserves metadata and the call row for retry.
- Admins can run the same policy as a dry run or immediate execution through `POST /admin/retention/run`.
- Retention success/failure/deletion metrics are exported. Legal holds and audit retention remain external policy requirements.

## Backup, Restore, And Deployment

- Backups contain a PostgreSQL custom-format dump, voicemail/call recordings, UTC/source metadata, and use an authenticated `ODBACKUP2` AES-256-GCM envelope derived with scrypt.
- The passphrase must be at least 32 characters and stored outside the host.
- Production preflight requires `BACKUP_S3_URI` unless `ALLOW_LOCAL_ONLY_BACKUPS=true` explicitly accepts the risk.
- Verification must authenticate/decrypt the envelope, validate both tar archives, and run `pg_restore --list`.
- Restore requires `RESTORE_CONFIRM=restore-<database>`, restores PostgreSQL with `--single-transaction`, snapshots current recordings before replacement, restarts the stack, and runs a web smoke test.
- Legacy unauthenticated AES-CBC archives are rejected unless `ALLOW_LEGACY_UNAUTHENTICATED_BACKUP=true` is set for a specifically trusted archive.
- Deployments are SHA-tagged, preflighted, quality-gated, blocked when active calls exist by default, backed up before migration, health-waited, smoke-tested, and recorded in `logs/deployment-state.env`.
- Database migrations are forward-only; application rollback reuses the previous compatible image and never rolls schema backward.
- SIP credential encryption moves from JWT-derived `v1` to independent-key `v2` only through the documented two-stage rollout, retaining a dual-read rollback target.

## Monitoring And Operations

- Structured application logs, health/readiness endpoints, Prometheus metrics, Grafana dashboards, Alertmanager rules, and Loki collection are included.
- Optional environment-controlled packet capture saves one protected PCAP per call, exposes capture health through Prometheus, and makes files available only to admins through Call History with bounded retention.
- The production owner must configure a real alert destination and an off-host uptime probe.
- SIP/RTP incidents must be correlatable by call ID, leg UUIDs, timestamps, event records, and deployed SHA.
- Firewall policy and host-port changes are explicitly outside this implementation pass. The deployment owner must assess and approve the existing network exposure separately.

## Production Acceptance Boundary

The repository can prove implementation and automated behavior. The following require target-environment evidence and remain open until recorded in [acceptance-checklist.md](acceptance-checklist.md):

- selected SIP-provider registration/routing and caller ID;
- real WSS, ringback/early media, DTMF, hangup causes, and external audio;
- full far-end voicemail recording on representative mailboxes;
- agreed concurrency/load/soak and restart/reconnect drills;
- off-host backup delivery and clean-host restore within approved RPO/RTO;
- legal approval for calling windows, retries, recording consent, DNCR evidence, retention, and legal hold;
- client training, runbook exercise, and formal sign-off.
