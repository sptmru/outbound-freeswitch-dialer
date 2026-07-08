# Requirements

## Confirmed Scope

The system is a single-tenant outbound dialer with a Web UI softphone. Agents work in the browser, but all PSTN call control is owned by the backend through FreeSWITCH ESL.

## Telephony

- Support SIP trunk integration.
- Support both SIP registration and IP-authenticated trunk modes.
- Trunk configuration can be file/environment driven; trunk setup through the Web UI is not required for the first version.
- Use provider-supplied SIP proxy, realm, outbound proxy, credentials, caller ID rules, and allowlisted production IPs.
- No explicit TLS/SRTP requirement for the SIP trunk, but WebRTC still requires secure browser transport.
- Use an efficient WebRTC codec path where possible, with Opus preferred for browser media and PSTN-compatible fallback/transcoding as required by FreeSWITCH and the SIP trunk provider.
- Concurrency is naturally limited by online agents rather than a hard business limit.

## Voicemail Drop

- Manual "Drop Voicemail" is required for MVP.
- Automatic voicemail/beep detection is not the source of truth for MVP, but the UI should surface detected VM/beep signals so the team can evaluate whether automation is reliable later.
- After voicemail playback completes, the customer leg should hang up automatically.
- Agents should be able to choose a voicemail recording, but one global default recording should be selected so agents do not need to choose every time.
- Recordings are global for the first version.
- Admins upload WAV or MP3; the backend transcodes to the runtime format needed by FreeSWITCH.

## Campaigns, Contacts, And Dialing

- Campaigns are in scope for the first version.
- Contacts/leads are imported from CSV.
- CSV import must support field mapping because files can have different column names and shapes.
- Agents can call campaign contacts/leads.
- Agents may also type arbitrary phone numbers when an admin setting allows manual dialing.
- Manual dialing must still pass backend authorization and suppression checks.

## Outcomes And Dispositions

Initial call outcomes should include:

- `answered`
- `not_answered`
- `busy`
- `failed`
- `voicemail_detected`
- `voicemail_dropped`
- `agent_canceled`
- `customer_hung_up`
- `suppressed`

The implementation may add lower-level technical reason codes, but the UI should keep agent-facing dispositions concise.

## DNCR And Suppression

- DNCR/suppression-list handling is in scope for MVP.
- Suppression checks must run before the backend originates any outbound customer leg.
- Suppression hits should be logged as call attempts or blocked actions, depending on final reporting needs.
- Broader legal/compliance ownership is out of scope for this build.

## Call Recording

- The product must support call recording.
- Call recording can be enabled or disabled by configuration/admin controls.
- Recording metadata should be stored with the call.
- Recording storage, retention, and backup policy need to remain operationally configurable.

## Users And Auth

- Use local username/password authentication.
- Roles for the first version are `agent` and `admin`.
- Agent SIP credentials should be created automatically when an agent is created.
- Dynamic short-lived SIP credentials are not required for the first version unless needed for security hardening later.

## Production And Operations

- Production target is Ubuntu 24 with current Docker.
- Deployment must allow the Web UI and WebRTC WSS domain to be configured at deploy time.
- Let's Encrypt certificate issuance/renewal should be automated.
- DNS and TLS are owned by the implementation team.
- Production is likely AWS-hosted and may sit behind NAT, so SIP/RTP/WebRTC NAT behavior must be part of the deployment design.
- Client owns persistent backups.
- Call logs should be retained for one week by default.
- Production alerts go to the client team.
- Troubleshooting must support collecting PCAP files and inspecting application, FreeSWITCH, ESL, and SIP/RTP logs.

## Design

- No existing brand/style guide.
- Single-tenant UI for the first version.
- During a call, agents should see all available lead information.
- If VM/beep detection signals are available, the active call UI must show them.
- Required admin screens should be derived from project scope:
  - Campaigns.
  - CSV imports and field mappings.
  - Recordings.
  - Users/agents.
  - Suppression list.
  - Call history and call detail timelines.
  - System settings for manual dialing, call recording, trunk/deployment status where safe to expose.
