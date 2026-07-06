# ADR 0001 - Initial Architecture

## Status

Proposed

## Context

The product needs an outbound dialer with a Web UI softphone, FreeSWITCH, ESL, Docker, Node.js, and TypeScript. It must support click-to-call, manual voicemail drop, prerecorded audio playback into an active call, agent release once playback starts, campaigns, CSV lead import, suppression checks, optional call recording, call logging, and Maxo SIP trunk integration.

A key security requirement is that calling must be backend-controlled rather than frontend-controlled. The browser should not be trusted to originate PSTN calls directly.

## Decision

Use a backend-controlled FreeSWITCH ESL architecture:

- Browser Web UI contains the agent softphone.
- Browser softphone registers to FreeSWITCH as an internal agent endpoint over SIP/WebRTC.
- Node.js TypeScript backend owns call origination, bridging, voicemail drop, and logging through ESL.
- FreeSWITCH handles media, SIP profiles, bridge behavior, Maxo trunking, and playback.
- PostgreSQL stores users, agents, campaigns, contacts, CSV imports, calls, call legs, recordings, suppression entries, call recording metadata, and call events.

For click-to-call, the backend should originate the agent leg first, then originate the customer leg through Maxo and bridge the two legs after both are ready.

For manual voicemail drop, the backend should move the customer leg into a controlled playback flow, start prerecorded audio playback, and release the agent leg after playback starts.

For Maxo, support both registration-based and IP-authenticated trunk configuration, selected through runtime configuration.

## Rationale

- Keeps PSTN call authority in the backend.
- Makes call state auditable through ESL events and database records.
- Keeps the browser focused on media and UX.
- Fits the requested FreeSWITCH ESL and Node.js TypeScript stack.
- Allows repeatable Docker-based local and production environments.

## Consequences

- We must carefully model call legs and call-state transitions.
- We must validate FreeSWITCH behavior for bridge teardown and voicemail playback early.
- WebRTC setup requires correct WSS, NAT, RTP, and TLS configuration.
- Production deployment must include SIP/RTP/firewall troubleshooting documentation.

## Alternatives Considered

- Frontend-originated SIP dialing from the browser.
  - Rejected because it violates backend-controlled calling.
- Asterisk ARI instead of FreeSWITCH ESL.
  - Not selected because the chosen stack is FreeSWITCH and ESL.
- Verto instead of SIP.js/SIP over WSS.
  - Possible fallback, but SIP.js with FreeSWITCH SIP over WebSocket is the recommended first path for a TypeScript web UI.
