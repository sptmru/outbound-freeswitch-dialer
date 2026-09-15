# Requirements

This document is the current product and operational contract. Items described as implemented are present in the repository; live-provider and production acceptance are tracked separately in [acceptance-checklist.md](acceptance-checklist.md).

## Product Boundary

- Single tenant.
- One interactive call per agent. A released voicemail customer leg may continue as a background job while the agent starts the next interactive call.
- Browser softphone for agent media; all PSTN origination and call control remain backend-owned through FreeSWITCH ESL.
- Local accounts with `agent` and `admin` roles. Admins may use Agent Desk; its SIP registration and microphone access start only while that view is open. A separate supervisor SIP identity registers only on **Live calls** and does not request microphone access in listen-only mode.
- Agent Desk audio setup lets an idle user select microphone and speaker devices, choose a browser microphone-processing profile, inspect the settings actually applied by the browser, and run a bounded microphone-level and ICE-readiness check. Device identifiers and the selected profile remain local to that browser.
- While an interactive call is active, the application keeps the user on Agent Desk. Sidebar navigation, browser history, deep links, and reload hydration must not leave the desk and stop the browser softphone.
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
- Agents and admins using Agent Desk can pause or resume themselves through `PATCH /agent/availability`, including during an active interactive call, without affecting that call.
- Paused agents cannot start campaign, lead, manual, or automatically advanced calls. Ending a call or launching a voicemail drop preserves a pause selected during that call; otherwise the agent returns to `available` immediately.
- Confirmed voicemail agent release is immediately available for the next interactive call. A pause selected while background voicemail continues must remain paused when that background job later completes.

## Telephony

- Support provider-neutral SIP registration and IP-authenticated trunk modes through runtime configuration.
- Keep provider credentials and routing details out of the product UI.
- Browser SIP uses WSS. PSTN codec/routing behavior must be validated with the selected provider.
- Use a backend-owned, agent-first originate/bridge flow; the browser never receives authority to choose the PSTN endpoint.
- Agent-initiated calls play browser-local ringback immediately while the internal WebRTC leg is still connecting. The browser tone stops on the first real remote audio, call-start failure, hangup, or softphone teardown; provider early media and the FreeSWITCH RTP-driven fallback remain authoritative after media begins.
- Store calls, legs, state-changing events, UUIDs, commands, hangup causes, and automatic outcomes required for diagnosis.
- Present call lifecycle status with the product vocabulary `Calling`, `Ringing`, `Answered`, `In progress`, `Failed`, `No answer`, `Cancelled`, `Completed`, and `Completed (voicemail dropped)`; keep technical states and outcomes internal.
- An authenticated agent may correct the terminal outcome of an owned ended call through the API. The first manual correction is immutable: later API requests and late or replayed FreeSWITCH events must not replace its state or outcome.
- Allow DTMF only when the backend reports the action eligible.
- Persist subscribed ESL events in arrival order through a bounded queue. Retry transient database failures with backoff; if the queue fills, disconnect/reconnect the listener and raise an observable overflow rather than silently discarding backlog.
- Reconcile unfinished database calls with FreeSWITCH `uuid_exists` after ESL subscription/reconnect and periodically. Missing calls are closed, orphaned agent legs are released when possible, and active voicemail playback is recovered or finalized.

## Live Call Supervision

- Active admins can list currently bridged agent/customer calls and start one supervisor session at a time. Monitoring always starts in server-enforced `listen` mode with browser microphone capture disabled.
- `whisper` requests microphone access and injects supervisor audio only toward the agent. `join` injects it toward both agent and customer and requires an explicit browser confirmation before the API request.
- Every supervisor connection uses a dedicated admin SIP identity and a separate FreeSWITCH leg/session record. It does not become an agent/customer `call_leg`, cannot originate through the browser-owned dialplan, and does not change the target call lifecycle.
- The API verifies the admin role, supervisor registration, durable call state, both current FreeSWITCH leg UUIDs, call ownership, and one-session exclusivity before originate. A shared transaction lock prevents an admin from starting an Agent Desk call concurrently with monitoring.
- Mode changes replace the supervisor leg. The API never enables `eavesdrop` DTMF mode switching, and it does not update the durable mode until FreeSWITCH confirms the previous leg was stopped.
- Agent Desk visibly identifies listen, whisper, and join states. Successful start/change/stop requests are attributed in `admin_audit_events`; session state and terminal failures remain in `call_supervisor_sessions`.
- Production enablement requires approved employee/customer notice, consent, recording, retention, access-control, and training policy for every applicable jurisdiction. The product does not play an automatic customer disclosure prompt.

## Contact Retry Policy

- Campaign contacts are selected transactionally with `FOR UPDATE SKIP LOCKED`.
- Suppressed, currently calling, and exhausted contacts are not callable. Completed contacts are excluded
  from automatic selection, but an agent may explicitly select one and confirm a repeat call.
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
- After a successful voicemail transfer, the agent leg is marked released only after the release is confirmed (or the channel is already absent). Originate liveness checks must treat that absence as intentional while the customer leg remains tracked until playback or a terminal event finishes the background job.
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
- Admins can download a campaign-scoped streaming ZIP of playable call recordings. UUID-named WAV entries are accompanied by a spreadsheet-safe manifest with call context and explicit reasons for rows skipped because a file is missing, empty, non-regular, or outside its canonical path. Empty exports return an explicit not-found response, and export starts are audited without phone numbers or storage paths.
- Default ticket TTL is 60 seconds; renewal is bounded by `MEDIA_TICKET_MAX_LIFETIME_SECONDS`.
- Recording storage, consent, legal hold, and deletion rules require client approval before production acceptance.

## Campaigns, Contacts, And Suppression

- Campaign states are `draft`, `active`, `paused`, and `archived`.
- Admins can create/edit campaigns, reset every campaign lead to new eligibility, bulk-export playable campaign call recordings, and configure manual dialing, call recording, early-media AVMD, and automatic next-lead calling per campaign. Resetting leads clears attempt/cooldown state, preserves call history and global suppression entries, and is blocked while the campaign has an active call. Automatic next-lead calling is opt-in and runs only after the current call has reached a terminal state.
- Archived campaigns preserve operational history and are not callable.
- Contact import accepts comma- or semicolon-separated CSV, auto-detects the delimiter from the header row, requires mapped `name` and `phone` values, preserves additional CSV columns in the contact/import JSON fields, normalizes numbers, reports row errors, and avoids duplicates. Upload byte and row ceilings reject oversized work before database writes without imposing a column whitelist.
- Campaign contacts and CSV row failures are paginated. Opening Contacts follows the campaign selected on Agent Desk, and every rejected CSV row remains reviewable instead of being silently limited to the first page.
- Agent Desk's Next leads/Lead queue shows a Zoho CRM link only for a non-empty imported `lead_id`, opening `https://crm.zoho.com.au/crm/org7002688441/tab/Leads/{lead_id}` in a new tab. IDs remain strings and are available regardless of CSV column position or the eight-field display limit.
- Manual numbers and campaign contacts both pass backend authorization and normalized suppression checks before originate.
- Agent Desk permits an explicit per-lead call during the retry cooldown only after confirmation. Automatic next-lead selection still observes the configured retry delay and attempt limit. Leads in cooldown show the latest call lifecycle result instead of a generic retry status.
- Suppression supports add/update, search, pagination, CSV import, and removal.
- Suppression changes and blocked manual-dial attempts create durable `suppression_events`.

## Users And Administrative Audit

- Admins can create, edit, deactivate/reactivate, change role, and reset passwords.
- Admins can assign an optional Caller ID to an agent. Outbound calls use that value first and fall back to the current global trunk Caller ID when the agent override is empty.
- Deactivation is rejected while the user has an active interactive call or supervisor session, revokes sessions, removes agent/supervisor registration material, and preserves historical attribution. Removing the admin role is likewise rejected until that user's supervisor session ends.
- Successful mutating `/admin/*` requests create `admin_audit_events` with actor, request ID, method, route, response status, source IP, user agent, bounded string route parameters, and timestamp.
- Audit history is paginated and filterable by actor, method, and date.
- Admins can update runtime product policies from Settings: default phone country, contact retry policy, export limit, retention windows/control, per-call PCAP capture, the global trunk caller ID, Alertmanager repeat interval, and enablement of deployment-configured notification channels. The UI distinguishes settings persistence from the asynchronous Alertmanager runtime-apply state.
- Runtime settings are stored in `system_settings`, audited through the normal `/admin/*` mutation hook, and override `.env` defaults without exposing alert credentials.
- Audit/retention/legal-hold duration is an external policy decision; it must not be assumed from call-log retention.

## History And Reporting

- Authenticated application sections have stable shareable URLs. The selected Agent Desk campaign is preserved in the URL across navigation and page reloads, and browser storage restores it when the application root is opened in another tab. An active interactive call overrides non-desk URLs until the call ends.
- Admin analytics are available on a dedicated shareable `/analytics` view backed by `GET /admin/analytics`. The view supports a bounded date range, browser IANA timezone, and optional campaign filter, and presents summary, daily trend, call funnel, campaign performance, agent performance, data-quality snapshot, voicemail lifecycle, AVMD reviewer evidence, per-leg media-quality coverage, and telephony reconciliation/finalization metrics.
- Admins can classify answered calls as human, machine, or uncertain from Call History. AVMD precision/recall and false-positive reporting use only persisted reviewer labels, expose their review coverage and confusion counts, and never present an unreviewed population as measured ground truth.
- Reporting distinguishes technical answer rate (`answered_at` / attempts) from connected-contact rate. A connected contact has answer evidence and excludes calls classified as detected or dropped voicemail; it is an operational proxy, not independently verified human-contact ground truth.
- Date-filtered call metrics and current contact-queue snapshots are labeled separately. Current callable/suppressed/exhausted counts must not be presented as historical values for the selected call period.
- Admin call history is paginated and filterable by text, campaign, agent, outcome, date range, voicemail drop/signal, and recording availability. Manual calls show a matching named lead when the normalized destination exists in any campaign; matches from the call's campaign take precedence, otherwise the most recently added named lead is used. Calls without a named match remain labeled **Manual dial**.
- Call detail includes lifecycle events and technical identifiers needed for diagnosis. The technical timeline is bounded to the latest 100 events and reports the total and whether older events were omitted.
- CSV export applies the same filters, refuses exports above `CALL_HISTORY_EXPORT_MAX_ROWS` (50,000 by default), and streams accepted rows in bounded pages.
- Outcomes are derived from backend call events. Agents do not select a mandatory post-call disposition in this version.

## Retention

- Automatic retention is enabled by default and runs at API startup and then every `RETENTION_RUN_INTERVAL_SECONDS` (86,400 seconds by default). Its enabled flag and retention windows can change without restarting the API.
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
- Grafana includes call-control and operations diagnostics for API latency/error rate, bounded call outcomes, ESL persistence backlog/retries/overflows, active/stuck voicemail work, recording finalization backlog, media-stat coverage and suspected one-way RTP, registration/active-call reconciliation, terminal finalization, retention/backup freshness, and host/container health. Product analytics remain in the authenticated admin application. Browser WebRTC calls submit bounded per-call summaries for loss, jitter, jitter-buffer delay, concealed samples, RTT, ICE path, negotiated codecs, and applied microphone processing; raw five-second samples are not persisted.
- Prometheus application dimensions must remain bounded. Call IDs, contact IDs, campaign IDs, agent IDs, destination numbers, and other history-sized identifiers are not metric labels.
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
