# Architecture

## Summary

The system should be built as a backend-controlled outbound dialer. The browser softphone is an authenticated media endpoint for the agent, while the backend owns call origination, bridging, voicemail drop, logging, and authorization.

## Components

```text
Browser Web UI
  - Agent dashboard
  - Admin screens
  - WebRTC softphone using SIP over WSS
  - API client plus live call-state subscription

Node.js TypeScript API
  - Auth and authorization
  - Call-control REST API
  - Live call-state WebSocket/SSE
  - ESL adapter
  - Call-state machine
  - Recording and user management

FreeSWITCH
  - WebRTC SIP profile for agent softphones
  - Maxo SIP gateway/profile for PSTN calls
  - Dialplan for bridge and voicemail-drop flows
  - ESL event source and command target

PostgreSQL
  - Users and agents
  - Calls and legs
  - Call events
  - Recordings
  - Suppression entries if in scope

Maxo
  - SIP trunk or compatible telephony setup
  - PSTN termination
```

## Security Model

- Frontend authenticates to the backend.
- Frontend does not receive credentials or permissions to place arbitrary PSTN calls.
- Browser softphone registers only as an agent endpoint.
- Click-to-call requests go to the backend.
- Backend validates agent identity, contact/campaign permissions, suppression rules, and call state.
- Backend sends ESL commands to FreeSWITCH.
- Backend records every call-control command and related ESL event.

## Recommended Call-Control Model

Use a backend-owned two-leg call:

1. Agent clicks "Call" in the dashboard.
2. Backend creates a call record and correlation ID.
3. Backend originates an internal call to the agent's WebRTC SIP endpoint.
4. Agent answers in the browser softphone.
5. Backend originates the customer leg through the Maxo gateway.
6. Backend bridges the agent and customer legs.
7. Backend streams state updates to the dashboard.

This model keeps the agent available before the customer is dialed and prevents the browser from directly originating external calls.

## Manual Voicemail Drop Flow

1. Agent is in an active bridged call.
2. Agent clicks "Drop Voicemail".
3. Backend validates:
   - Agent owns the call.
   - Customer leg is active.
   - Call is in a state that allows voicemail drop.
   - Selected recording is active and permitted.
4. Backend marks the call as `voicemail_drop_requested`.
5. Backend moves the customer leg into a voicemail playback flow.
6. Backend starts playback of the selected prerecorded audio on the customer leg.
7. Backend releases the agent leg once playback starts.
8. Backend records playback completion or interruption.
9. Backend sets final call outcome.

FreeSWITCH implementation details should be validated in the first telephony spike. The likely approach is to transfer the customer leg to a controlled dialplan context that plays the recording and then hangs up or completes according to product rules, while the agent leg is released separately.

## Call State Machine

Initial states:

- `created`
- `agent_ringing`
- `agent_answered`
- `customer_dialing`
- `customer_ringing`
- `bridged`
- `voicemail_drop_requested`
- `voicemail_playback_started`
- `agent_released`
- `voicemail_playback_completed`
- `completed`
- `failed`
- `canceled`

Terminal states:

- `completed`
- `failed`
- `canceled`

Every transition should include:

- Call ID.
- Agent ID.
- Customer leg UUID if available.
- Agent leg UUID if available.
- ESL event name or API command name.
- Timestamp.
- Reason code.
- Raw diagnostic fields needed for troubleshooting.

## Data Model Draft

### users

- `id`
- `email`
- `name`
- `role`
- `created_at`
- `updated_at`

### agents

- `id`
- `user_id`
- `sip_username`
- `display_name`
- `status`
- `last_registered_at`
- `created_at`
- `updated_at`

### calls

- `id`
- `agent_id`
- `destination_number`
- `caller_id`
- `state`
- `outcome`
- `recording_id`
- `started_at`
- `answered_at`
- `ended_at`
- `created_at`
- `updated_at`

### call_legs

- `id`
- `call_id`
- `type` (`agent` or `customer`)
- `freeswitch_uuid`
- `sip_uri`
- `state`
- `answered_at`
- `ended_at`
- `hangup_cause`
- `created_at`
- `updated_at`

### call_events

- `id`
- `call_id`
- `leg_id`
- `type`
- `source` (`api`, `esl`, `system`)
- `payload_json`
- `created_at`

### recordings

- `id`
- `name`
- `storage_path`
- `duration_ms`
- `codec`
- `status`
- `created_by`
- `created_at`
- `updated_at`

### suppression_entries

- `id`
- `phone_number`
- `reason`
- `source`
- `created_at`

## Runtime Configuration Draft

- `DATABASE_URL`
- `JWT_SECRET`
- `PUBLIC_APP_URL`
- `API_PORT`
- `FREESWITCH_ESL_HOST`
- `FREESWITCH_ESL_PORT`
- `FREESWITCH_ESL_PASSWORD`
- `FREESWITCH_SIP_DOMAIN`
- `FREESWITCH_WEBRTC_WSS_URL`
- `FREESWITCH_RTP_START_PORT`
- `FREESWITCH_RTP_END_PORT`
- `MAXO_SIP_MODE`
- `MAXO_SIP_PROXY`
- `MAXO_SIP_USERNAME`
- `MAXO_SIP_PASSWORD`
- `MAXO_SIP_FROM_DOMAIN`
- `MAXO_OUTBOUND_CALLER_ID`
- `RECORDINGS_PATH`

## Observability

- Use structured JSON logs.
- Include `callId`, `agentLegUuid`, `customerLegUuid`, and `eslEventName` where available.
- Persist ESL events that affect call state.
- Emit metrics for:
  - Calls started.
  - Calls bridged.
  - Calls failed by reason.
  - Voicemail drops requested.
  - Voicemail playback started/completed/interrupted.
  - ESL reconnects.
  - SIP registration state changes.

## Key Risks

- NAT, RTP, and WebRTC media path issues.
- Maxo trunk requirements that differ between local and production.
- FreeSWITCH bridge behavior when one leg is released.
- Race conditions around voicemail drop and customer hangup.
- Browser microphone permission and autoplay behavior.
- Operational access to production logs and SIP traces.
