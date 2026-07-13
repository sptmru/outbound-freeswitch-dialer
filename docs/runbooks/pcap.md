# SIP and RTP capture runbook

Captures can contain phone numbers, SIP credentials, caller IDs, and customer audio metadata. Limit capture duration and interfaces, store files with mode `0600`, transfer them only through an approved secure channel, and delete them according to the approved incident/legal-hold policy.

Capture authorization, storage, retention, and deletion are external policy decisions. This runbook describes evidence collection; it does not grant permission to capture production traffic.

## Automatic per-call capture

Set the following deployment values and redeploy to capture every new call:

```dotenv
PCAP_CAPTURE_ENABLED=true
PCAP_CAPTURE_INTERFACE=any
PCAP_RETENTION_DAYS=7
```

The `pcap-capture` service starts `tcpdump` before the API sends the FreeSWITCH originate command and stops it after the call reaches a terminal state. Each call gets a protected `<call-id>.pcap` file in the `pcap_storage` Docker volume. Admins can inspect capture status, size, and failures and download an available file from **Call history**. Capture failures are recorded without blocking the call.

The capture filter is generated from the configured internal/external SIP, TLS/WSS, and RTP ports. It is not accepted as free-form UI or environment input. When calls overlap, their files cover overlapping time windows on the same host ports and can therefore include packets from the other call. Treat every capture as production-sensitive even when it is attached to one call ID.

Prometheus exposes `outbound_dialer_pcap_capture_enabled`, `outbound_dialer_pcap_captures_active`, `outbound_dialer_pcap_capture_failures_window`, `outbound_dialer_pcap_storage_bytes`, and the PCAP retention counter. Grafana is for capture health and capacity; the application remains the authenticated file catalogue and download surface.

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
