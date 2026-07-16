# Outbound Dialer Implementation Status And Completion Plan

This document reconciles the original delivery plan with the current repository. “Implemented” means source and automated coverage exist; it does not mean the target SIP provider, production host, or client has accepted the behavior.

## Outcome

The planned single-tenant operational MVP is implemented in the repository. The remaining path to “complete” is evidence and external decision work: provider configuration, real call/voicemail validation, policy approval, load/recovery/restore drills, accessibility review, training, and sign-off.

## Phase Status

| Phase                      | Repository status                       | Remaining acceptance                                               |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| 0. Scope and discovery     | Product scope locked                    | Provider values, topology, legal/operational owners                |
| 1. Foundation              | Implemented                             | Clean-environment onboarding evidence                              |
| 2. FreeSWITCH/WebRTC       | Implemented                             | Target WSS/provider/NAT call validation                            |
| 3. Backend call control    | Implemented                             | Live call matrix and agreed concurrency                            |
| 4. Voicemail and recording | Implemented                             | Far-end mailbox proof and consent approval                         |
| 5. Agent experience        | Implemented                             | Accessibility/usability acceptance                                 |
| 6. Admin/reporting         | Implemented                             | Client workflow/report sign-off                                    |
| 7. Reliability/testing     | Mechanisms and tests implemented        | Full CI evidence, load/soak, restart/recovery drills               |
| 8. Production operations   | Scripts/monitoring/runbooks implemented | Target-host deploy, off-host alert/backup, restore/rollback drills |
| 9. Handover                | Guides/checklist present                | Training, owner assignment, formal acceptance                      |

Firewall and host-published-port changes were excluded by instruction. They are not counted as completed and require a separate deployment-owner review.

## Completed Repository Work

### 1. Foundation And Data Integrity

- npm workspaces for API, web, and shared contracts; strict TypeScript, ESLint, Prettier, tests, builds, and CI workflow.
- PostgreSQL migrations for users, agents, campaigns, contacts, calls, legs, events, recordings, suppression, media tickets, live notifications, administrative audit, and lifecycle hardening.
- Transactional migration runner with advisory serialization/checksums and startup provisioning.
- Database constraints and uniqueness for core lifecycle values, one agent per user, active-call/contact claims, and FreeSWITCH UUIDs.
- Liveness/readiness endpoints that distinguish process health from PostgreSQL/ESL readiness.

### 2. Authentication, Sessions, And Secrets

- Local password authentication with `agent` and `admin` roles.
- Browser sessions in an HttpOnly, production-secure, `SameSite=Strict` cookie.
- Origin allowlist CSRF protection for cookie-authenticated mutations; Bearer compatibility retained for explicit API clients.
- Per-IP login rate limiting, safe proxy trust, active-user/auth-version checks, logout, and session revocation on password reset/deactivation.
- Generated agent SIP credentials and FreeSWITCH directory provisioning.
- Dual-read SIP secret format with opt-in writes: rollback-compatible `v1`, independent-key `v2`, and transactional startup migration.

### 3. FreeSWITCH, WSS, And Call Control

- Repo-owned FreeSWITCH templates and runtime rendering for ESL, internal WebRTC, provider-neutral registration/IP-auth trunking, codecs, WSS, dialplan, and recordings.
- SIP.js browser provisioning and registration only on Agent Desk, with remote audio cleanup and registration reconciliation.
- Backend-owned agent-first originate/bridge, suppression and campaign authorization before originate, DTMF, hangup, and active-call eligibility.
- Transactional next-contact claim using `FOR UPDATE SKIP LOCKED` and uniqueness guards against duplicate interactive calls.
- Explicit call/leg/event persistence, originate watchdog, automatic outcome mapping, and contact lifecycle updates.
- ESL frame unwrapping, custom-event subscription, agent registration updates, recording/AVMD startup, and reconnect retry.
- Bounded ordered ESL persistence queue, exponential retry for transient database failures, explicit overflow disconnect/reconnect, queue metrics/alerts, and subscription-aware readiness.
- Coalesced reconciliation after ESL subscription/reconnect and every configured interval: check active UUIDs, finalize missing calls, release orphaned agent legs where possible, and recover/finalize voicemail jobs.

### 4. Voicemail Lifecycle And Audio

- Transactional/idempotent voicemail-drop claim.
- Distinct lifecycle timestamps and events for request, playback start, agent release, completion, failure, and interruption.
- FreeSWITCH custom events emitted from the voicemail dialplan; completion is no longer inferred immediately from transfer.
- Agent release occurs after playback-start evidence and only advances database state after confirmed release/already-missing channel.
- Customer leg stays tracked as a background job until a terminal event; the agent may start another interactive call after release.
- Reconciliation handles lost/restarted listeners without claiming a missing customer channel completed successfully.
- WAV/MP3 upload is decoded and converted by ffmpeg/ffprobe to mono 8 kHz PCM WAV with loudness normalization and a five-minute limit.
- Global recording list/default/preview/deactivation and call recording on the customer leg.
- Scoped, short-lived, hashed media tickets and byte-range streaming for voicemail/call recording playback.

### 5. Agent Experience And Live Updates

- Agent Desk with campaign selection, next lead, manual number validation, click-to-call, DTMF, hangup, call timer/state, action eligibility, and automatic outcomes.
- Manual voicemail selection/drop with background job tray and failure/interruption visibility.
- VM/beep/AVMD signals shown as advisory evidence, never as an automatic drop trigger.
- Admin access to Agent Desk without starting SIP/microphone outside the desk view, with active-call navigation/history/deep links forced back to the desk so the browser phone remains registered.
- Credentialed SSE refresh hints from PostgreSQL changes, EventSource reconnect, heartbeat, debounced refresh, and periodic HTTP fallback.
- Minimal `name` + `phone` CSV workflow and product-facing copy that hides telephony plumbing.

### 6. Administration, History, And Audit

- Dedicated period- and campaign-filtered admin Analytics view with summary KPIs, daily movement, call funnel, campaign/agent performance, data-quality snapshot, and voicemail lifecycle reporting.
- Explicit metric definitions separate technical answers from connected contacts and separate period-filtered facts from current queue snapshots.
- Campaign create/edit/status/archive plus manual-dial, recording, and early-media AVMD flags.
- Paginated campaign contacts and CSV import failures, selected-campaign continuity from Agent Desk, row feedback, search, filters, and manual contact actions.
- User create/edit/deactivate/reactivate/role/password lifecycle with preserved attribution and FreeSWITCH cleanup.
- Suppression add/update/search/pagination/import/removal and durable change/blocked-dial events.
- Paginated/filterable call history, detailed event timeline with explicit latest-100 truncation status, bounded CSV export, and media playback.
- Stable per-section application URLs with browser back/forward support plus URL- and browser-persisted Agent Desk campaign selection.
- Successful mutating admin requests recorded with actor/request/route/status/source metadata and bounded route parameters; paginated audit endpoint with actor/method/date filters.
- Database-backed admin runtime policies with `.env` fallback for dialing, phone normalization, exports, retention, PCAP, caller ID, and safe Alertmanager channel/repeat controls.

### 7. Retention, Monitoring, And Operations

- Automatic retention at startup and a configurable interval, protected by a PostgreSQL advisory lock and in-process overlap guard.
- Seven-day call-log and 30-day call-recording defaults.
- Recording-aware deletion: call rows are retained while recording data is younger; metadata is cleared only after successful unlink or confirmed absence; failures preserve the row for retry.
- Admin dry-run/immediate retention endpoint plus success/failure/deletion metrics.
- Prometheus, Grafana, Alertmanager, Loki, Alloy, host/container/PostgreSQL/exporter checks, public HTTPS blackbox probe, and provisioned alerts/dashboard.
- Call-control/operations panels for API latency/error rate, bounded outcome mix, ESL queue health, voicemail jobs, recording finalization, retention, backup, TLS, and restart signals without per-call or per-user Prometheus labels.
- Runtime-native validation of all monitoring configs before deploy/restore, plus a dedicated read-only `outbound_dialer_exporter` PostgreSQL role instead of reusing the application-owner connection.
- Production preflight for secret strength, env permissions, pinned FreeSWITCH image, alert destination, off-host backup or explicit exception, and Compose validation.
- Quality-gated SHA-tagged deployment, active-call guard, pre-deploy backup, one migration run, health wait, certificate/cron setup, smoke test, and deployment-state record.
- Previous-image rollback with explicit confirmation and forward-only database compatibility.
- `ODBACKUP2` authenticated AES-256-GCM backups, optional S3 upload, verification, freshness metrics, guarded transactional restore, recordings snapshot, and smoke test.
- Agent/admin guides, deployment/backup/incident/PCAP runbooks, limitations, and acceptance checklist.

## Remaining Work Before Production Acceptance

### P0 — External Decisions And Live Telephony

- Obtain and record provider mode, proxy/realm/outbound proxy, credentials, caller ID rules, allowlisted IPs, codecs, response/hangup behavior, and throughput constraints.
- Confirm target DNS, certificate names, public/NAT topology, advertised SIP/RTP addresses, and provider reachability.
- Run a production-like call matrix: WSS registration, ringback/early media, human answer, busy, reject, no-answer, agent/customer hangup, DTMF, provider error, and recording.
- Verify several representative far-end mailboxes record the complete voicemail after the agent is released. Local playback events are diagnostic evidence only.
- Approve calling windows/timezone, retry/outcome policy, recording consent, DNCR evidence, retention/legal hold, and audit duration.

### P0 — Recovery And Operational Proof

- Run deploy and rollback drills with zero active calls and retain timestamps/logs/SHA evidence.
- Deliver an authenticated backup off-host, verify it, and perform a clean-host database/recordings restore within approved RPO/RTO.
- Exercise API restart, ESL disconnect/reconnect, FreeSWITCH restart, missing customer leg, interrupted voicemail playback, and provider rejection.
- Configure a named Alertmanager receiver and an independent off-host uptime check; prove test alerts reach operators.
- Assign owners/escalation contacts and exercise the incident and capture runbooks.

### P1 — Quality And Handover Evidence

- Run the complete CI/quality suite on the final SHA, including browser E2E and Compose validation.
- Execute agreed multi-agent load/soak and race scenarios; record latency/error thresholds, duplicate-call checks, stuck-state checks, and database/resource growth.
- Perform keyboard/screen-reader/focus/contrast review of Agent Desk and destructive admin flows.
- Train agents/admins, review limitations, capture feedback, and sign the production checklist.

## Improvements Beyond The Original MVP

These additions should follow acceptance of the current behavior, not block it unless the client explicitly promotes them:

- Outcome-specific scheduled callbacks, configurable post-call wrap-up, reason-coded pauses, and supervisor requeue controls beyond the implemented ready/pause flow.
- Representative AVMD review cohorts and runtime calibration of media-quality thresholds remain operational follow-ups. The product now persists reviewer ground truth, per-leg FreeSWITCH RTP quality/codec/provider evidence, reconciliation snapshots, and terminal finalization latency; these sources still require adequate sample coverage before policy decisions.
- Object storage for recordings with lifecycle, immutable/legal-hold support, checksum verification, and managed key rotation.
- Generated OpenAPI/runtime schemas so API and web share validation, not TypeScript types alone.
- Split large call-control/UI modules behind one explicit transition service/state machine.
- Accessibility shortcuts for call, hangup, DTMF, and voicemail with collision-safe confirmations.
- Automatic voicemail drop only after measured AVMD performance, representative cohort review, and legal approval.
- High availability or multi-tenancy only if the product moves beyond its current single-host/single-tenant operating model.

## Definition Of Done

The project is fully complete against this plan only when:

1. the repository implementation remains green on the accepted SHA;
2. all P0 external decisions have named owners and recorded answers;
3. target-environment call, voicemail, restart, load, deploy/rollback, alert, backup, and restore evidence is attached;
4. firewall/host-port review is handled separately by the deployment owner;
5. client training and the [production acceptance checklist](acceptance-checklist.md) are signed off.
