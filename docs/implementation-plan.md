# Outbound Dialer Implementation Plan

## Goal

Build a production-ready outbound dialer where agents use a browser softphone for calls, while all outbound telephony actions remain backend-controlled. The system must support:

- Click-to-call from an agent dashboard.
- Manual "Drop Voicemail" action during an active call.
- Agent release from the call once voicemail playback starts.
- Prerecorded voicemail audio played into the active customer leg.
- Call state tracking, audit logging, and outcome tracking.
- Maxo integration through SIP trunking or a compatible telephony setup.
- Secure call control owned by the backend, not by browser extensions or frontend-originated PSTN calls.

## Delivery Principles

- Build vertical slices that can be demonstrated end to end.
- Keep FreeSWITCH call-control behavior observable through ESL events and explicit call-state records.
- Treat the browser softphone as an authenticated agent endpoint, not as an authority to dial PSTN destinations.
- Store every call-control action and telephony event needed to debug a call later.
- Document operational setup while building it, not after the fact.
- Keep implementation choices reversible until validated with a real Maxo trunk.

## Phase 0 - Discovery And Scope Lock

### Tasks

- Confirm Maxo SIP trunk details:
  - Registration mode or IP-auth mode.
  - SIP proxy, realm, outbound proxy, codec requirements, caller ID policy, allowed IPs.
  - TLS/SRTP requirements if any.
- Confirm production host constraints:
  - Public IP, firewall, NAT, TLS certificate strategy, DNS, deploy access.
  - Required ports for SIP, RTP, ESL, API, WebSocket, and WebRTC WSS.
- Confirm product boundaries:
  - Manual voicemail drop only, or automatic voicemail/beep detection too.
  - Single prerecorded voicemail per account, per campaign, per agent, or per call.
  - Admin roles and user management source.
  - DNCR/suppression-list requirements and legal ownership.
- Confirm data inputs:
  - Where contacts/leads come from.
  - Whether campaigns are in scope for the first build.
  - Required call outcomes and dispositions.

### Deliverables

- Updated [open questions](open-questions.md).
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
  - Recordings.
  - Suppression entries if in scope.

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
  - RTP port range and NAT configuration.
  - TLS certificate mount for WSS where needed.
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
- Implement ESL call orchestration:
  - Originate an agent leg to the authenticated agent's registered WebRTC endpoint.
  - After the agent answers, originate the customer leg through Maxo.
  - Bridge the two legs.
  - Persist call, leg, bridge, answer, hangup, and failure events.
- Add authorization rules:
  - Agent can start calls only for allowed contacts/campaigns.
  - Agent can only control calls assigned to them.
  - Admin can inspect all calls.
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
  - Validate file format, codec, duration, and safe filename.
- Implement API:
  - `POST /calls/:id/drop-voicemail`.
  - Request includes selected recording ID.
  - Backend validates agent ownership and current call state.
- Implement FreeSWITCH behavior:
  - Identify the customer leg and agent leg for the active bridge.
  - Transfer or park the customer leg into a voicemail-drop dialplan/app.
  - Play the prerecorded audio into the customer leg.
  - Release the agent leg immediately after playback starts.
  - Hang up or mark the customer leg complete after playback ends, based on selected behavior.
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
  - Completed.
  - No answer.
  - Busy.
  - Failed.
  - Voicemail dropped.
  - Agent canceled.
  - Customer hung up.
- Implement admin recording controls:
  - Upload/update/delete recordings.
  - Activate/deactivate recordings.
  - Preview playback.
  - Restrict recordings by tenant/account/campaign if needed.
- Implement user controls:
  - Basic admin-created users for MVP, unless an external identity provider is required.
  - Agent permissions.
  - Admin permissions.
- Implement suppression/DNCR if in scope:
  - Import list.
  - Manual add/remove.
  - Enforce check before `POST /calls` originates any call.
  - Log suppression hits.

### Deliverables

- Admin can manage recordings and users.
- Agents and admins can inspect call outcomes.
- Suppression handling is either implemented or documented as out of scope.

### Acceptance Criteria

- Every call has a final outcome.
- Every voicemail drop has an associated recording ID and event timeline.
- Admin actions are audit logged.

## Phase 6 - UI Design And Product Polish

### Tasks

- Produce Figma designs for:
  - Agent dashboard.
  - Embedded softphone states.
  - Active call controls.
  - Drop voicemail confirmation/selection.
  - Call history.
  - Admin recordings.
  - Admin users.
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
  - TLS certificates.
  - Persistent volumes for PostgreSQL, FreeSWITCH config, recordings, and logs.
- Deploy services:
  - API.
  - Web app.
  - PostgreSQL.
  - FreeSWITCH.
  - Reverse proxy for HTTPS/WSS.
- Configure Maxo trunk:
  - SIP gateway.
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
9. Admin recording management.
10. Production deployment and handover.

This sequence gives us a demoable system early and keeps the highest-risk telephony behavior visible from the start.
