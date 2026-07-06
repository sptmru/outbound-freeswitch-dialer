# Open Questions

## Maxo And SIP Trunk

- Is the Maxo trunk registration-based or IP-authenticated?
- What SIP proxy, realm, and outbound proxy should be used?
- What codecs are required or preferred?
- Are TLS and SRTP required?
- What caller ID format does Maxo require?
- Are production server IPs already allowlisted?
- Are there concurrent call limits?

## Voicemail Drop Behavior

- Is manual voicemail drop sufficient for MVP, or is automatic voicemail/beep detection required?
- After voicemail playback completes, should the customer leg hang up automatically?
- Can agents choose from multiple recordings, or is there one default recording?
- Are recordings global, per account, per campaign, or per agent?
- What audio format should admins upload, and can the system transcode it?

## Product Scope

- Where do contacts/leads come from?
- Are campaigns in scope for the first version?
- What call dispositions are required?
- Is DNCR/suppression-list handling in scope for MVP?
- Are call recordings required, or only voicemail audio playback?
- Should agents be able to type arbitrary numbers, or only call provided contacts?

## Users And Auth

- Should the system use local username/password auth or an external identity provider?
- What roles are needed beyond `agent` and `admin`?
- Do agent SIP credentials need to be short-lived/provisioned dynamically?

## Production Environment

- What Linux distribution and Docker version are on the production server?
- What domain will be used for the Web UI and WebRTC WSS?
- Who owns DNS and TLS certificate management?
- What firewall/NAT rules are available?
- Where should persistent backups be stored?

## Compliance And Operations

- Who owns compliance requirements around outbound dialing and DNCR?
- How long should call logs be retained?
- Are audit logs required for admin actions?
- Who receives production alerts?
- What support process should be followed for failed calls?

## Design

- Is there an existing brand/style guide?
- Should the UI be single-tenant or multi-tenant from day one?
- What data should be visible to agents during a call?
- What admin screens are required for the first handover?
