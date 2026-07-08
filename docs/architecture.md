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
  - Campaign, lead, recording, suppression, and call-history workflows

Node.js TypeScript API
  - Auth and authorization
  - Call-control REST API
  - Live call-state WebSocket/SSE
  - ESL adapter
  - Call-state machine
  - Campaign, CSV import, recording, suppression, call-recording, and user management

FreeSWITCH
  - WebRTC SIP profile for agent softphones
  - SIP trunk gateway/profile for PSTN calls, supporting registration and IP-auth modes
  - Dialplan for bridge and voicemail-drop flows
  - Optional call recording and VM/beep signal experiments
  - ESL event source and command target

PostgreSQL
  - Users and agents
  - Campaigns and contacts/leads
  - CSV imports and field mappings
  - Calls and legs
  - Call events
  - Recordings
  - Call recording metadata
  - Suppression entries
  - System settings

SIP trunk provider
  - SIP trunk or compatible telephony setup
  - PSTN termination
```

## Product Assumptions

- Single-tenant for the first version.
- Local username/password auth with `agent` and `admin` roles.
- Agents get SIP credentials automatically when they are created.
- Campaigns and CSV lead import are in scope.
- CSV imports require field mapping.
- DNCR/suppression checks are mandatory before customer-leg origination.
- Agents may type arbitrary numbers only when an admin setting enables manual dialing.
- Call recording must be supported and can be enabled or disabled.
- Call logs are retained for one week by default.

## Security Model

- Frontend authenticates to the backend.
- Frontend does not receive credentials or permissions to place arbitrary PSTN calls.
- Browser softphone registers only as an agent endpoint.
- Click-to-call requests go to the backend.
- Backend validates agent identity, contact/campaign permissions, suppression rules, and call state.
- Backend validates manual dialing settings before accepting arbitrary destination numbers.
- Backend sends ESL commands to FreeSWITCH.
- Backend records every call-control command and related ESL event.

## Recommended Call-Control Model

Use a backend-owned two-leg call:

1. Agent clicks "Call" in the dashboard.
2. Backend creates a call record and correlation ID.
3. Backend originates an internal call to the agent's WebRTC SIP endpoint.
4. Agent answers in the browser softphone.
5. Backend originates the customer leg through the SIP trunk gateway.
6. Backend bridges the agent and customer legs.
7. Backend streams state updates to the dashboard.

This model keeps the agent available before the customer is dialed and prevents the browser from directly originating external calls.

Before step 5, the backend must normalize the destination number and enforce suppression checks. If the call target is an arbitrary manually typed number, the backend must also verify that manual dialing is enabled.

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
10. Customer leg hangs up automatically after voicemail playback completes.

FreeSWITCH implementation details should be validated in the first telephony spike. The likely approach is to transfer the customer leg to a controlled dialplan context that plays the recording and then hangs up or completes according to product rules, while the agent leg is released separately.

## VM/Beep Detection Signal Flow

Manual voicemail drop remains the MVP control path. VM/beep detection should be implemented as an observable signal, not an automatic action, until reliability is proven.

Expected behavior:

1. FreeSWITCH or an integrated detection mechanism emits a detection event or confidence signal.
2. Backend stores the event with the call timeline.
3. Backend streams the signal to the active agent UI.
4. UI shows the signal in the active call panel.
5. Agent still decides whether to click "Drop Voicemail".

Detection data should preserve raw event details so future automation decisions can be based on actual call evidence.

## Call State Machine

Initial states:

- `created`
- `agent_ringing`
- `agent_answered`
- `customer_dialing`
- `customer_ringing`
- `bridged`
- `voicemail_signal_detected`
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

## Dispositions

Agent/admin-facing outcomes:

- `answered`
- `not_answered`
- `busy`
- `failed`
- `voicemail_detected`
- `voicemail_dropped`
- `agent_canceled`
- `customer_hung_up`
- `suppressed`

Technical reason codes should be stored separately from the user-facing outcome.

## Data Model Draft

### users

- `id`
- `email`
- `name`
- `role`
- `password_hash`
- `created_at`
- `updated_at`

### agents

- `id`
- `user_id`
- `sip_username`
- `sip_password_hash` or encrypted SIP secret reference
- `display_name`
- `status`
- `last_registered_at`
- `created_at`
- `updated_at`

### campaigns

- `id`
- `name`
- `status`
- `manual_dialing_enabled`
- `call_recording_enabled`
- `created_at`
- `updated_at`

### contacts

- `id`
- `campaign_id`
- `phone_number`
- `normalized_phone_number`
- `display_name`
- `source_row_json`
- `mapped_fields_json`
- `status`
- `created_at`
- `updated_at`

### csv_imports

- `id`
- `campaign_id`
- `filename`
- `status`
- `field_mapping_json`
- `total_rows`
- `imported_rows`
- `failed_rows`
- `created_at`
- `completed_at`

### calls

- `id`
- `agent_id`
- `campaign_id`
- `contact_id`
- `destination_number`
- `normalized_destination_number`
- `caller_id`
- `state`
- `outcome`
- `recording_id`
- `manual_dial`
- `call_recording_enabled`
- `call_recording_path`
- `voicemail_signal_status`
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
- `source_format`
- `transcoded_path`
- `is_default`
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

### system_settings

- `id`
- `key`
- `value_json`
- `updated_at`

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
- `SIP_TRUNK_MODE`
- `SIP_TRUNK_REGISTRATION_ENABLED`
- `SIP_TRUNK_PROXY`
- `SIP_TRUNK_REALM`
- `SIP_TRUNK_OUTBOUND_PROXY`
- `SIP_TRUNK_USERNAME`
- `SIP_TRUNK_PASSWORD`
- `SIP_TRUNK_FROM_DOMAIN`
- `SIP_TRUNK_CALLER_ID`
- `RECORDINGS_PATH`
- `CALL_RECORDINGS_PATH`
- `DEFAULT_CALL_RECORDING_ENABLED`
- `MANUAL_DIALING_ENABLED`
- `CALL_LOG_RETENTION_DAYS`
- `LETSENCRYPT_EMAIL`
- `PUBLIC_WSS_DOMAIN`

## Observability

- Use structured JSON logs.
- Include `callId`, `agentLegUuid`, `customerLegUuid`, and `eslEventName` where available.
- Persist ESL events that affect call state.
- Emit metrics for:
  - Calls started.
  - Calls bridged.
  - Calls failed by reason.
  - Voicemail drops requested.
  - VM/beep signals detected.
  - Voicemail playback started/completed/interrupted.
  - Suppression hits.
  - Call recordings started/stopped/failed.
  - ESL reconnects.
  - SIP registration state changes.

For support, production docs must include how to collect PCAP files and correlate them with API logs, FreeSWITCH logs, ESL events, and database call IDs.

## Key Risks

- NAT, RTP, and WebRTC media path issues.
- AWS NAT and advertised SIP/RTP IP mismatches.
- SIP trunk requirements that differ between local and production.
- FreeSWITCH bridge behavior when one leg is released.
- VM/beep detection reliability.
- Race conditions around voicemail drop and customer hangup.
- Browser microphone permission and autoplay behavior.
- Operational access to production logs and SIP traces.
