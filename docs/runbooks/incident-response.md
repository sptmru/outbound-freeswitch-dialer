# Incident Response Runbook

## First Response

1. Record UTC start time, affected agent/campaign, call ID, masked destination, deployed/current/previous SHA, and observed UI state.
2. Stop new calls when state correctness, media, provider routing, recording, or suppression integrity is uncertain. Do not terminate a customer leg without confirming impact.
3. Check `/api/health/ready`, Grafana/Alertmanager, ESL listener, SIP trunk readiness, active/stuck calls, API errors, SSE/DB-listener errors, retention/backup freshness, storage, and container restarts.
4. Preserve evidence before restarting: relevant database rows/events/audit records, application/container/FreeSWITCH logs, SIP ladder, RTP summary, and exact timestamps.
5. Assign incident commander, technical owner, client/provider contact, severity, and next update time.

Use the configured runtime-log tooling first when available. Do not copy production `.env`, raw cookies/JWTs, SIP passwords, backup passphrases, or unredacted customer data into tickets/chat.

## Correlation Handles

- `calls.id` / `call_events.call_id`;
- agent/customer `freeswitch_uuid` and `call_legs` rows;
- FreeSWITCH `variable_outbound_dialer_call_id`;
- ESL background `job-uuid`;
- campaign/contact/agent/user/recording IDs;
- HTTP `request.id` and `admin_audit_events.request_id`;
- deployed SHA from `logs/deployment-state.env`.

## Safe Recovery Order

1. Query whether FreeSWITCH still owns each leg with `uuid_exists`/`show channels`.
2. Let the application reconnect/reconciliation path compare unfinished database calls with real channels. Prefer it over manual SQL.
3. For voicemail, distinguish requested, playback started, agent released, and terminal events. A transfer request or local file is not completion evidence.
4. If ESL is disconnected, restore it and confirm event subscription/reconciliation before modifying call rows or channels.
5. Restart the smallest affected component after evidence capture and only when no customer media will be orphaned.
6. Use previous-image rollback for a new-code regression. Use database restore only for confirmed corruption/data loss.

Do not manually mark a voicemail job successful because its customer UUID is missing; reconnect reconciliation intentionally classifies unconfirmed missing playback as incomplete/failed.

## Common Incident Branches

### Browser auth or stale UI

- Confirm cookie presence/expiry flags without exposing its value, account `is_active`/`auth_version`, allowed `Origin`, public proxy origin, and API 401/403/429 responses.
- Confirm `/agent/events` returns credentialed SSE, heartbeats continue, PostgreSQL listener is subscribed, and HTTP fallback refresh still works.
- A blocked SSE connection should reduce freshness, not authorize or mutate state; REST remains authoritative.

### Call start rejected with HTTP 409

- Search API logs for `event=call_start_rejected` and correlate `requestId` with the HTTP completion. The record includes the route, `actorUserId`, `agentId`, `campaignId`, `contactId`, and the exact `reason`. A rejected start has no call ID and does not appear in Call History.
- `agentRegistration` captures `registered`, `availabilityStatus`, `lastRegisteredAt`, and `lastUnregisteredAt` from the locked agent row used to decide the rejection. It is null when a gate rejects before that row is read. IDs that have not yet been resolved are also null; for example, a lead's campaign may not be resolved before an agent registration rejection. HTTP response messages and status codes remain unchanged.
- For `agent_not_registered`, compare this snapshot with `agent_registration_updated` logs for the same `agentId` or `sipUsername`. `source=sofia_event` records persisted `sofia::register`, `sofia::unregister`, and `sofia::expire` events (including registration renewals); `source=reconciliation` records rows corrected from the live FreeSWITCH registration table. These logs use an explicit field allowlist and exclude passwords, authentication headers, cookies, raw SIP frames, and destination numbers.
- Check both `telephony_observability_state.registration_reconciled_at` in PostgreSQL and the metrics snapshot freshness timestamp. A fresh Prometheus scrape can still contain stale application gauges. Use a direct read-only `sofia status profile internal-webrtc reg` check when freshness is uncertain; do not infer current registration from stale zeros.
- One-shot ESL requests have a five-second total deadline, including authentication, and reject on premature connection closure or inactivity. Failed requests release the reconciliation/metrics overlap guards so a later scheduled run can retry. This does not automatically retry an originate or another uncertain call-control command: inspect its UUIDs and events before a manual retry.
- Preserve browser SIP/WebRTC diagnostics and custom-client request context when the registration history cannot distinguish an actual WSS disconnect from stale database state. The structured logs only cover requests and registration changes after this version is deployed; they do not reconstruct older missing response bodies.

### Media or voicemail

- Compare browser WebRTC and provider/customer RTP separately.
- Inspect canonical voicemail metadata, file existence/size, custom playback events, agent release command result, and terminal event.
- For call/voicemail preview, check ticket scope/expiry and byte-range response; never place the session JWT in a query string.
- Do not close a delivery incident until the far-end mailbox result is verified when that is the requirement.

### Retention or filesystem

- Stop manual reruns if eligibility is disputed; run dry-run and preserve affected call IDs/paths.
- A non-`ENOENT` unlink failure should leave recording metadata and the call row. Investigate permissions/storage and rerun only after correction.
- Confirm audit/legal-hold policy before deleting anything manually.

### Backup or restore

- Treat an `ODBACKUP2` authentication failure as wrong secret, truncation, or tampering until proven otherwise. Do not enable the legacy override for an expected authenticated archive.
- Preserve the failed archive and metadata, select a separately verified off-host version, and follow the restore runbook.
- Keep the pre-restore recordings snapshot until drill/recovery sign-off.

## Closure

Document symptoms, impact, confirmed cause, affected calls/data, exact commands, evidence, remediation, verification, deployed commit, provider/client conclusions, and follow-ups. Save durable incident knowledge only after the cause/resolution is verified.

An incident is not closed merely because health is green, a local recording exists, or playback completed locally. Verify the user-visible/provider-side result and monitor for recurrence.
