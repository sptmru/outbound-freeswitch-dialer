# ADR 0002 - Product Scope Decisions

## Status

Accepted

## Context

The first requirements clarification answered major scope questions around SIP trunking, voicemail behavior, campaigns, CSV imports, suppression, call recording, authentication, production deployment, and UI design.

## Decision

Build the first version with these assumptions:

- Single-tenant product.
- Local username/password authentication.
- Roles limited to `agent` and `admin`.
- Agent SIP credentials are generated automatically when an agent is created.
- SIP trunk supports both registration-based and IP-authenticated modes.
- SIP trunk configuration is deployment/runtime configuration, not Web UI configuration.
- Manual "Drop Voicemail" is the MVP behavior.
- VM/beep detection is visible to agents as a signal but does not automatically control voicemail drop in MVP.
- Customer leg hangs up automatically after voicemail playback completes.
- Voicemail recordings are global, with one global default recording.
- Admins upload WAV/MP3 recordings; the system transcodes them for FreeSWITCH.
- Campaigns and CSV lead import are in scope. ADR 0003 supersedes the immediate field-mapping requirement with a `name` and `phone` contract.
- DNCR/suppression-list enforcement is in scope.
- Agents may type arbitrary numbers only when admins enable manual dialing.
- Call recording is in scope and can be enabled or disabled.
- Call logs retain for one week by default.
- Production target is Ubuntu 24 with current Docker, automated Let's Encrypt, and AWS/NAT-aware SIP/RTP/WebRTC configuration.
- Troubleshooting must support PCAP capture and log inspection.

## Rationale

- Supporting both SIP trunk modes avoids blocking development on provider details.
- Manual voicemail drop satisfies the client requirement while VM/beep visibility creates evidence for future automation.
- Campaigns, validated CSV import, and suppression are needed for a usable outbound workflow rather than a raw dial pad. Flexible field mapping is deferred by ADR 0003.
- Local auth and single-tenancy keep the first implementation focused.
- Global recordings with a default reduce agent friction while preserving recording choice.
- Runtime trunk configuration avoids exposing sensitive telephony settings in the first admin UI.

## Consequences

- The data model must include campaigns, contacts, CSV imports, suppression entries, system settings, and call recording metadata from the start.
- The UI must include admin flows for campaigns, CSV imports, recordings, users, suppression, call history, and settings.
- The FreeSWITCH/ESL layer must expose enough event detail to show VM/beep signals without relying on them for automation.
- Deployment must explicitly handle WebRTC WSS, SIP/RTP ports, NAT, and Let's Encrypt.

## Alternatives Considered

- Only support one SIP trunk mode.
  - Rejected because the provider details are not known yet.
- Automatic voicemail drop based on detection.
  - Deferred until detection reliability is proven from real calls.
- Per-campaign or per-agent voicemail recordings.
  - Deferred; global recordings are simpler for the first version.
- External identity provider.
  - Deferred; local auth is sufficient for MVP.
