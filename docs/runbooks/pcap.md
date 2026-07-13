# SIP and RTP capture runbook

Captures can contain phone numbers, SIP credentials, caller IDs, and customer audio metadata. Limit capture duration and interfaces, store files with mode `0600`, transfer them only through an approved secure channel, and delete them according to the approved incident/legal-hold policy.

Capture authorization, storage, retention, and deletion are external policy decisions. This runbook describes evidence collection; it does not grant permission to capture production traffic.

## SIP ladder

Start before the controlled reproduction:

```bash
sudo sngrep -r -O /secure/path/incident.pcap
```

If `sngrep` does not capture the relevant namespace/interface, use `tshark` and specify the host interface:

```bash
sudo tshark -i any -f 'udp port 5060 or tcp port 5060 or tcp port 7443 or udp portrange 16384-16484' \
  -w /secure/path/incident.pcapng
```

WSS SIP payloads are encrypted on the wire; correlate them with FreeSWITCH logs and ESL events rather than expecting readable SIP messages in that leg.

## RTP summary

```bash
tshark -r /secure/path/incident.pcapng -q -z rtp,streams
```

Compare provider/customer RTP and browser WebRTC media separately. A clean server-side recording does not prove the browser media path was healthy, and local voicemail playback does not prove the far-end mailbox stored the message.

## Evidence package

Include UTC timestamps, call ID, both leg UUIDs, masked endpoints, SIP response/hangup cause, RTP stream table, packet-loss/jitter observations, and the deployed SHA. Never attach the production `.env`, session cookies/JWTs, media-ticket tokens, SIP passwords, backup secrets, or unredacted access logs.
