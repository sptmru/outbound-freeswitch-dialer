# Open Questions

Only external, provider, live-call, legal, and operational-ownership decisions remain here. Implemented product behavior is defined in [requirements.md](requirements.md); repository status is in [implementation-plan.md](implementation-plan.md).

## SIP Provider And Target Topology

- Will the selected trunk use registration or IP authentication?
- What are the exact SIP proxy, realm, outbound proxy, username/password, from-domain, and caller-ID requirements?
- Which public IPs must the provider allowlist, and what concurrent-call/rate limits apply?
- Which codecs, DTMF mode, early-media behavior, timers, and SIP response/hangup causes must be supported?
- What is the final host/public-IP/NAT/load-balancer topology, and which advertised SIP/RTP/WSS addresses are correct?
- What are the final dialer and Grafana DNS names and certificate ownership contacts?

The repository supports both trunk modes and configurable NAT/WSS values; these questions require the chosen provider and target environment.

## Live Call And Voicemail Acceptance

- Does production WSS registration remain stable through the real proxy/NAT path and supported browsers?
- Are ringback, early media, two-way audio, DTMF, agent/customer hangup, busy, reject, no-answer, and provider failure mapped correctly on the selected trunk?
- Do representative mobile, carrier, PBX, and visual-voicemail mailboxes record the full message after the agent leg is released?
- What measured voicemail/AVMD false-positive and false-negative rates are acceptable before any future automation is considered?
- What concurrency, call-rate, duration, and soak target must the installation pass?

These require dated evidence from the target environment. Local FreeSWITCH events or recordings alone are not acceptance proof.

## Legal And Client Policy

- Which jurisdictions and timezones apply, and what calling windows/holiday rules are permitted?
- Which automatic outcomes are legally/operationally retryable, how many attempts are permitted, and is the current default of three attempts with a 15-minute delay approved?
- What evidence/source/timestamp must be retained for DNCR and suppression entries, imports, and removals?
- Is call recording enabled, who must be notified, and what consent method is required?
- What are the approved retention periods for call metadata, call recordings, voicemail assets, suppression evidence, admin audit, logs, captures, and backups?
- Is legal hold required, and who can place/release it?
- May administrators export call history containing phone numbers, and what access/review controls are required?

## Recovery And Operational Ownership

- Who owns production, the SIP account, DNS/TLS, alerts, backups, incident command, and client escalation?
- What RPO/RTO must backup and restore meet, and which off-host S3 account/bucket/region is approved?
- Which Alertmanager destinations and off-host uptime service must page the client team?
- How often must restore, rollback, incident, and PCAP drills run, and who signs the evidence?
- What is the approved secure storage/transfer/deletion workflow for SIP/RTP captures?
- Who owns the separate firewall and host-port exposure review that was explicitly excluded from this implementation pass?

## Exit Condition

Each answer needs an owner, decision date, target environment, and acceptance evidence where applicable. Once resolved, move it into requirements/operations policy and update the [acceptance checklist](acceptance-checklist.md); do not leave an answered item here.
