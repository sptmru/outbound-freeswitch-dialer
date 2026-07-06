# FreeSWITCH Runtime Config

This directory is mounted into the FreeSWITCH container at:

```text
/etc/freeswitch/dialer
```

The first deployable backend slice only needs ESL reachability for health
checks. The next telephony slice should add provider-specific FreeSWITCH config:

- WebRTC SIP profile for browser SIP over WSS.
- ESL password wiring from `FREESWITCH_ESL_PASSWORD`.
- Maxo gateway config for `MAXO_TRUNK_MODE=registration`.
- IP-authenticated outbound routing for `MAXO_TRUNK_MODE=ip_auth`.
- NAT and RTP settings for the production host.
- Voicemail drop dialplan context.

Keep provider secrets in `.env`; do not commit rendered XML files containing
credentials.
