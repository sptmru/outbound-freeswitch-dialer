# Outbound Dialer Implementation Plan

## Goal

Build a production-ready outbound dialer where agents use a browser softphone for calls, while all outbound telephony actions remain backend-controlled. The system must support:

- Click-to-call from an agent dashboard.
- Manual "Drop Voicemail" action during an active call.
- Agent release from the call once voicemail playback starts.
- Prerecorded voicemail audio played into the active customer leg.
- Campaigns with CSV lead import and field mapping.
- DNCR/suppression checks before dialing.
- Optional manual number entry controlled by admin settings.
- Optional call recording controlled by configuration/admin settings.
- VM/beep detection signals visible to agents when available, while manual voicemail drop remains the MVP control path.
- Call state tracking, call-control/event logging, and outcome tracking.
- Maxo integration through SIP trunking or a compatible telephony setup.
- Secure call control owned by the backend, not by browser extensions or frontend-originated PSTN calls.

## Delivery Principles

- Build vertical slices that can be demonstrated end to end.
- Keep FreeSWITCH call-control behavior observable through ESL events and explicit call-state records.
- Treat the browser softphone as an authenticated agent endpoint, not as an authority to dial PSTN destinations.
- Store every call-control action and telephony event needed to debug a call later.
- Document operational setup while building it, not after the fact.
- Keep implementation choices reversible until validated with a real Maxo trunk.
- Keep provider-specific trunk details out of the Web UI for the first version; configure them through deployment/runtime configuration.

## Phase 0 - Discovery And Scope Lock

### Tasks

- Confirm Maxo SIP trunk details:
  - Registration mode or IP-auth mode from the provider, while implementation supports both.
  - SIP proxy, realm, outbound proxy, codec requirements, caller ID policy, allowed IPs.
  - No Maxo TLS/SRTP requirement is assumed, but WebRTC WSS remains required for browser media.
- Confirm production host constraints:
  - Ubuntu 24, current Docker, public IP/firewall/NAT shape, TLS certificate strategy, DNS, deploy access.
  - Required ports for SIP, RTP, ESL, API, WebSocket, and WebRTC WSS.
- Confirm product boundaries:
  - Manual voicemail drop is MVP behavior; VM/beep detection is displayed as a signal for future automation evaluation.
  - Global recordings with one default recording.
  - Local username/password auth with `agent` and `admin` roles.
  - DNCR/suppression-list checks are in MVP; broader compliance ownership is out of scope.
- Confirm data inputs:
  - Contacts/leads come from CSV import.
  - Campaigns are in scope.
  - CSV field mapping is required for different source formats.
  - Required call outcomes and dispositions.

### Deliverables

- Updated [open questions](open-questions.md).
- Updated [requirements](requirements.md).
- Maxo trunk checklist.
- Confirmed MVP acceptance criteria.

### Acceptance Criteria

- No unknowns block the first end-to-end demo.
- Any deferred items are explicitly marked as post-MVP or blocked by external input.

## Phase 1 - Repository And Local Environment Foundation

### Tasks

- Create the monorepo structure:
  - `apps/api` for Node.js TypeScript backend.
  - `apps/web` for Web UI.
  - `packages/shared` for shared types and schemas.
  - `infra/freeswitch` for FreeSWITCH configuration.
  - `infra/docker` for Docker Compose and runtime scripts.
- Add baseline tooling:
  - TypeScript strict mode.
  - ESLint and formatter.
  - Unit test runner.
  - Docker Compose for API, web, FreeSWITCH, and PostgreSQL.
  - `.env.example` with required runtime variables.
- Create initial database migrations:
  - Users.
  - Agents.
  - Calls.
  - Call legs.
  - Call events.
  - Campaigns.
  - Contacts/leads.
  - CSV import jobs.
  - CSV field mappings.
  - Recordings.
  - Call recording settings and metadata.
  - Suppression entries.
  - System settings.
  - VM/beep detection events.
- Add local auth:
  - Password hashing.
  - Session/JWT handling.
  - `agent` and `admin` roles.
  - Automatic SIP credential generation for agents.

### Deliverables

- Local Docker environment boots deterministically.
- API health check can reach PostgreSQL and FreeSWITCH ESL.
- Web app can reach API health endpoint.

### Acceptance Criteria

- A new developer can run one documented command and see all local services healthy.
- FreeSWITCH ESL connectivity is tested by the backend at startup and exposed in health output.

## Phase 2 - FreeSWITCH And WebRTC Softphone Baseline

### Tasks

- Configure FreeSWITCH SIP profiles:
  - Internal WebRTC profile for browser SIP over WSS.
  - External gateway/profile for Maxo trunk.
  - Support both registration-based and IP-authenticated Maxo trunk configuration.
  - RTP port range and NAT configuration.
  - TLS certificate mount for WSS where needed.
- Configure codec strategy:
  - Prefer Opus for WebRTC browser media where practical.
  - Support PSTN-compatible fallback/transcoding for Maxo, likely PCMU/PCMA depending on provider behavior.
- Select and integrate browser SIP client:
  - Recommended first option: SIP.js with FreeSWITCH SIP over WebSocket.
  - Keep the browser limited to agent registration and answering backend-originated internal calls.
- Implement agent endpoint lifecycle:
  - Agent logs in to Web UI.
  - Agent softphone registers with FreeSWITCH using short-lived backend-issued credentials or provisioned credentials.
  - UI shows registration state, microphone permission state, and active call state.
- Add backend tracking of agent availability:
  - Online/offline.
  - SIP registered/unregistered.
  - Idle/ringing/in-call/wrapping.

### Deliverables

- Browser softphone can register to FreeSWITCH locally.
- Backend can detect or infer agent registration state.
- Agent can receive an internal test call.

### Acceptance Criteria

- The browser cannot directly dial arbitrary PSTN numbers.
- Internal test calls show useful state transitions in the UI and backend logs.

## Phase 3 - Backend-Owned Click-To-Call

### Tasks

- Implement authenticated backend API:
  - `POST /calls` to request click-to-call.
  - `GET /calls/:id` for current call state.
  - WebSocket or Server-Sent Events for live call updates.
- Implement campaign/contact APIs:
  - CSV upload.
  - Field mapping preview.
  - Campaign contact list.
  - Campaign activation/pausing.
- Implement ESL call orchestration:
  - Originate an agent leg to the authenticated agent's registered WebRTC endpoint.
  - After the agent answers, originate the customer leg through Maxo.
  - Bridge the two legs.
  - Persist call, leg, bridge, answer, hangup, and failure events.
- Add authorization rules:
  - Agent can start calls only for allowed contacts/campaigns.
  - Agent can type arbitrary numbers only when admin settings allow manual dialing.
  - Agent can only control calls assigned to them.
  - Admin can inspect all calls.
- Add suppression rules:
  - Normalize destination numbers before dialing.
  - Check suppression list before originating the customer leg.
  - Log suppressed attempts without sending them to FreeSWITCH/Maxo.
- Add failure handling:
  - Agent unavailable.
  - Agent rejects or misses the internal call.
  - Maxo trunk failure.
  - Customer busy/no-answer.
  - ESL disconnect/reconnect.

### Deliverables

- Agent dashboard click-to-call works locally with a test SIP target.
- Call-state events stream to the UI in real time.
- All state transitions are written to PostgreSQL.

### Acceptance Criteria

- No PSTN destination is sent from the frontend directly to FreeSWITCH.
- Backend logs include enough correlation IDs to trace every call leg.
- Hangup from either side produces a final call outcome.

## Phase 4 - Manual Voicemail Drop And Agent Release

### Tasks

- Add recording management foundation:
  - Store metadata in PostgreSQL.
  - Mount audio files into FreeSWITCH.
  - Accept WAV/MP3 uploads from admins.
  - Transcode uploads to the runtime format required by FreeSWITCH.
  - Validate file format, codec, duration, and safe filename.
  - Support a global default recording.
- Implement API:
  - `POST /calls/:id/drop-voicemail`.
  - Request includes selected recording ID.
  - Backend validates agent ownership and current call state.
- Implement FreeSWITCH behavior:
  - Identify the customer leg and agent leg for the active bridge.
  - Transfer or park the customer leg into a voicemail-drop dialplan/app.
  - Play the prerecorded audio into the customer leg.
  - Release the agent leg immediately after playback starts.
  - Hang up the customer leg automatically after playback completes.
- Add VM/beep signal handling:
  - Capture detection events or inferred signals where FreeSWITCH/provider behavior allows it.
  - Show VM/beep status to the agent without automatically triggering voicemail drop in MVP.
  - Persist detection events for later reliability analysis.
- Persist call outcome:
  - `voicemail_drop_requested`.
  - `voicemail_playback_started`.
  - `agent_released`.
  - `voicemail_playback_completed`.
  - Final call disposition.
- Add defensive handling:
  - Button disabled until a bridged customer leg exists.
  - Idempotent drop request.
  - Race between customer hangup and drop request.
  - Race between agent hangup and drop request.

### Deliverables

- Manual "Drop Voicemail" button works end to end.
- Agent leg disconnects once voicemail playback starts.
- Customer leg continues long enough to play the selected audio.

### Acceptance Criteria

- A live demo call proves the full voicemail-drop-and-release flow.
- Event log clearly shows agent release and customer playback as separate events.
- Repeated button presses do not start duplicate playback.

## Phase 5 - Call Logging, Outcomes, And Admin Controls

### Tasks

- Implement call history views:
  - Agent call log.
  - Admin call log.
  - Per-call timeline with ESL/API events.
- Implement dispositions/outcomes:
  - Answered.
  - Not answered.
  - Busy.
  - Failed.
  - Voicemail detected.
  - Voicemail dropped.
  - Agent canceled.
  - Customer hung up.
  - Suppressed.
- Implement admin recording controls:
  - Upload/update/delete recordings.
  - Activate/deactivate recordings.
  - Set global default recording.
  - Preview playback.
- Implement user controls:
  - Local username/password users.
  - Automatic agent SIP credential generation.
  - Agent permissions.
  - Admin permissions.
- Implement campaign and CSV controls:
  - Campaign create/edit/pause/archive.
  - CSV upload.
  - Field mapping.
  - Import validation.
  - Lead list and import error review.
- Implement suppression/DNCR:
  - Import list.
  - Manual add/remove.
  - Enforce check before `POST /calls` originates any call.
  - Log suppression hits.
- Implement call recording controls:
  - Global or campaign-level toggle, pending final setting choice.
  - Store recording metadata with calls.
  - Show recording state where relevant.
- Implement retention:
  - Default one-week retention for call logs unless configured otherwise.
  - Clarify whether retention applies to all metadata or detailed event payloads only.

### Deliverables

- Admin can manage recordings and users.
- Admin can manage campaigns, CSV imports, and suppression list.
- Agents and admins can inspect call outcomes.
- Suppression handling prevents outbound calls before origination.

### Acceptance Criteria

- Every call has a final outcome.
- Every voicemail drop has an associated recording ID and event timeline.
- Call recording status is visible in call detail.

## Phase 6 - UI Design And Product Polish

### Tasks

- Produce Figma designs for:
  - Agent dashboard.
  - Embedded softphone states.
  - Active call controls.
  - Drop voicemail confirmation/selection.
  - Lead detail panel with all available imported fields.
  - VM/beep detection signal display.
  - Campaign list and campaign workspace.
  - CSV upload and field mapping.
  - Call history.
  - Admin recordings.
  - Admin users.
  - Admin suppression list.
  - Admin system settings for manual dialing and call recording.
  - Empty, loading, error, and permission states.
- Implement the UI from design:
  - React TypeScript app.
  - Shared design tokens.
  - Responsive desktop-first agent workflow.
  - Accessible controls for call actions.
- Add real-time state handling:
  - Registration status.
  - Call progress.
  - Active bridge state.
  - VM/beep detection signal state.
  - Voicemail playback state.
  - Failure messages that map to backend reasons.

### Deliverables

- Figma file linked from docs once created.
- Implemented UI matches approved design.
- Dashboard is usable for the live demo without hidden developer tools.

### Acceptance Criteria

- Primary call workflow can be completed by an agent without instructions.
- Dangerous actions are confirmed or safely constrained.
- UI never shows a call action that the backend would reject for the current state.

## Phase 7 - Reliability, Race-Condition, And Load Testing

### Tasks

- Add automated tests:
  - Unit tests for call-state reducer/state machine.
  - API integration tests for authorization and idempotency.
  - ESL adapter tests with mocked events.
  - UI component tests for call controls.
- Add scenario tests:
  - Agent misses internal call.
  - Customer no-answer.
  - Customer hangs up during voicemail drop.
  - Agent clicks drop voicemail twice.
  - Suppressed number blocks before customer leg origination.
  - CSV import with alternate field names.
  - Manual dialing disabled blocks arbitrary number entry.
  - VM/beep detection event appears in call timeline.
  - ESL reconnect during active call.
  - Maxo trunk returns failure.
- Add load and soak tests:
  - Concurrent agents.
  - Concurrent outbound calls.
  - Event storm handling.
  - Database write pressure.
- Add observability:
  - Structured logs.
  - Correlation IDs.
  - Metrics for calls, failures, ESL reconnects, voicemail playback.
  - Health checks and readiness checks.

### Deliverables

- Repeatable test commands.
- Documented known limits.
- Load-test report before production rollout.

### Acceptance Criteria

- Critical race conditions are covered by tests.
- Backend recovers from ESL reconnect without corrupting terminal call states.
- Load test reaches agreed target concurrency.

## Phase 8 - Production Deployment

### Tasks

- Prepare Linux server:
  - Docker runtime.
  - Firewall rules.
  - DNS.
  - Automated Let's Encrypt TLS certificates.
  - Persistent volumes for PostgreSQL, FreeSWITCH config, recordings, and logs.
- Prepare AWS/NAT deployment details:
  - Public signaling endpoints.
  - RTP port exposure.
  - SIP advertised host/IP settings.
  - WebRTC WSS domain configuration.
- Deploy services:
  - API.
  - Web app.
  - PostgreSQL.
  - FreeSWITCH.
  - Reverse proxy for HTTPS/WSS.
- Configure Maxo trunk:
  - SIP gateway in registration or IP-auth mode.
  - Caller ID.
  - Codecs.
  - NAT/RTP.
  - Allowed IPs.
- Run production validation:
  - Browser registration.
  - Click-to-call.
  - Manual voicemail drop.
  - Agent release.
  - Call logs.
  - Admin recording controls.

### Deliverables

- Production deployment running on the target server.
- Deployment docs with exact commands and environment variables.
- Troubleshooting docs for SIP, WebRTC, RTP, ESL, and Maxo failures.
- PCAP capture procedure for failed-call investigation.

### Acceptance Criteria

- A live production-like call completes the full flow.
- Server reboot/redeploy behavior is documented and validated.
- Rollback path is documented.

## Phase 9 - Handover

### Tasks

- Create handover docs:
  - Agent dashboard usage.
  - Admin recording management.
  - User management.
  - Voicemail-drop workflow.
  - Common troubleshooting.
  - Deployment and rollback.
- Run training session:
  - Agent workflow.
  - Admin workflow.
  - Basic operations.
  - What logs to inspect for failed calls.
- Finalize delivery package:
  - Source code.
  - Environment templates.
  - Architecture docs.
  - Test evidence.
  - Known limitations.

### Deliverables

- Full setup, deployment, and troubleshooting documentation.
- Handover training completed.
- Final acceptance demo completed.

### Acceptance Criteria

- Team can run the app, place calls, drop voicemail, and inspect failures without developer intervention.
- Remaining follow-ups are documented with owners and priority.

## Suggested MVP Slice Order

1. Local Docker foundation with FreeSWITCH, API, web, and PostgreSQL.
2. Browser softphone registration to FreeSWITCH.
3. Backend-originated internal test call to agent softphone.
4. Backend click-to-call with a test SIP endpoint.
5. Maxo SIP trunk integration.
6. Full bridge: agent leg plus customer leg.
7. Manual voicemail drop with agent release.
8. Call logging and timeline.
9. Campaign CSV import and suppression enforcement.
10. Admin recording management with default voicemail recording.
11. Optional call recording controls.
12. VM/beep signal display.
13. Production deployment and handover.

This sequence gives us a demoable system early and keeps the highest-risk telephony behavior visible from the start.
