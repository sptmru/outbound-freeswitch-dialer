# Open Questions

This file tracks remaining unknowns only. Confirmed decisions are captured in [requirements](requirements.md).

## SIP Trunk

- Which SIP trunk mode will the provider give us: registration-based or IP-authenticated?
  - Requirement: support both modes.
- What exact SIP proxy, realm, outbound proxy, username, password, and from-domain will the SIP trunk provider provide?
- What caller ID format does the SIP trunk provider require?
- Which production server IPs need to be allowlisted?
- Does the SIP trunk provider require any codec constraints beyond normal PSTN compatibility?

## Voicemail And Detection

- Which FreeSWITCH detection approach will be reliable enough for VM/beep signal display?
  - Requirement: detection is visible to agents but manual drop remains the MVP source of truth.
- What confidence/status values should the UI show for VM/beep detection?
- Should voicemail-detection events influence reporting only, or later trigger automatic drop behavior?

## CSV And Campaigns

- Which additional lead fields, beyond the current required `name` and `phone`, will future client CSV files contain?
- When real CSV samples require more fields, should the product add interactive field mapping or a fixed client-specific schema?
- Can the same contact appear in multiple campaigns?
- Should duplicate phone numbers be deduplicated globally or per campaign?
- What campaign states are needed for MVP: draft, active, paused, completed?

## Outcomes And Reporting

- Should agents be allowed to override automatically determined outcomes in a later version?
- Should `voicemail_detected` and `voicemail_dropped` be separate reportable outcomes?
- What is the exact mapping from SIP/FreeSWITCH hangup causes to agent-facing dispositions?
- Should suppressed calls appear in agent call history or only admin reports?

## Call Recording

- Should call recording default to on or off?
- Is call recording controlled globally, per campaign, or per agent?
- Where will production call recordings be stored if the client handles backups?
- Should agents see whether a call is being recorded?

## Production Environment

- What final domain will be used for the Web UI and WebRTC WSS?
- What AWS topology will be used: direct public EC2, public load balancer, or private instance behind NAT?
- What exact SIP/RTP ports will be opened and forwarded?
- What log collection destination will the client team use for alerts?

## Operations

- What exact PCAP capture workflow is acceptable in production?
- Who on the client team receives alerts and operational handover?
- Should one-week call-log retention apply to all call metadata, or only detailed event/log payloads?
