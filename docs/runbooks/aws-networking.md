# AWS Network And WebRTC NAT Runbook

## Supported Topology

Run the single-host stack on an EC2 instance in a public subnet with an Internet Gateway and a stable Elastic IPv4 address. The instance still sees only its private VPC address; AWS performs one-to-one public/private address translation at the edge.

Do not place the host only behind a NAT Gateway. A NAT Gateway provides outbound connectivity and cannot accept the inbound HTTPS, SIP, RTP, or TURN traffic this stack requires. An ALB can front HTTP/WSS but cannot carry UDP media. A load-balanced telephony topology requires a separately designed NLB and media path.

Set the public and private addresses explicitly:

```dotenv
FREESWITCH_EXTERNAL_SIP_IP=203.0.113.10
FREESWITCH_EXTERNAL_RTP_IP=203.0.113.10
TURN_RELAY_IP=10.0.1.10
```

`FREESWITCH_EXTERNAL_*` must be the Elastic IP, and `TURN_RELAY_IP` must be the primary private IPv4 shown on the EC2 network interface. Do not use `auto-nat`: FreeSWITCH is started with NAT discovery disabled, and AWS does not expose a UPnP/NAT-PMP gateway.

For a server whose public address is assigned directly to its network interface and which is not behind NAT, use that same public address for all three settings:

```dotenv
FREESWITCH_EXTERNAL_SIP_IP=198.51.100.20
FREESWITCH_EXTERNAL_RTP_IP=198.51.100.20
TURN_RELAY_IP=198.51.100.20
```

Coturn adds an explicit `public/private` address mapping only when `FREESWITCH_EXTERNAL_RTP_IP` and `TURN_RELAY_IP` differ. When they are equal, it binds and advertises the directly assigned address without a NAT mapping.

## Browser ICE And Coturn

The authenticated softphone provisioning response contains:

- Google STUN URLs from `ICE_STUN_URLS`;
- Coturn URLs from `TURN_URLS`;
- a short-lived username and HMAC-SHA1 credential generated from `TURN_SHARED_SECRET`.

Coturn uses the same primary DNS name as the application on separate ports:

```dotenv
TURN_URLS=turn:dialer.example.com:3478?transport=udp,turn:dialer.example.com:3478?transport=tcp,turns:dialer.example.com:5349?transport=tcp
```

The shared secret is never included in the browser bundle or response. Rotate it as a coordinated API/Coturn deployment; credentials already issued before rotation remain invalid after the containers restart.

Coturn reads the primary domain's Let's Encrypt certificate from the shared certificate volume. On first bootstrap it starts the plain TURN listener so ACME can complete; `ensure-cert.sh` recreates Coturn afterward to enable TURN/TLS. Certificate renewal recreates Coturn to load the renewed files.

## AWS Security Group Inbound Rules

| Protocol |        Port | Source                                                                  | Purpose                              |
| -------- | ----------: | ----------------------------------------------------------------------- | ------------------------------------ |
| TCP      |          80 | `0.0.0.0/0`, and `::/0` if IPv6 is enabled                              | ACME HTTP-01 and HTTPS redirect      |
| TCP      |         443 | approved agent networks, or `0.0.0.0/0`                                 | Web UI, API, Grafana, SIP.js WSS     |
| UDP      | 16384-16484 | approved agent networks and provider media CIDRs; otherwise `0.0.0.0/0` | Direct browser SRTP and provider RTP |
| UDP      |        5080 | SIP provider signaling CIDRs only                                       | SIP trunk when the provider uses UDP |
| TCP      |        5080 | SIP provider signaling CIDRs only                                       | Only when the provider uses SIP/TCP  |
| TCP      |        5081 | SIP provider signaling CIDRs only                                       | Only when the provider uses SIP/TLS  |
| UDP      |        3478 | approved agent networks, or `0.0.0.0/0`                                 | TURN/STUN listener                   |
| TCP      |        3478 | approved agent networks, or `0.0.0.0/0`                                 | TURN over TCP fallback               |
| TCP      |        5349 | approved agent networks, or `0.0.0.0/0`                                 | TURN over TLS                        |
| UDP      | 49152-49252 | `0.0.0.0/0`                                                             | Coturn relay allocations             |
| TCP      |          22 | deployment/admin CIDRs only                                             | SSH                                  |

Restrict SIP signaling to the provider's published CIDRs. Agent source addresses often change; if they cannot be enumerated, expose the WebRTC/TURN ports to the Internet and rely on WSS authentication, short-lived TURN credentials, host firewalling, logging, quotas, and fail2ban.

Do not expose `5060`, `7443`, `8021`, `3000`, `8080`, PostgreSQL, Prometheus, Loki, or internal exporter ports. The public browser WSS path is HTTPS `443` at `/freeswitch-ws`; `7443` is only the proxy-to-FreeSWITCH upstream.

AWS Security Groups are stateful. If a custom network ACL is also used, remember that it is stateless and must allow the corresponding return traffic and ephemeral ports. Mirror the required inbound rules in `ufw`/nftables when a host firewall is enabled.

## Verification

After deployment:

```bash
docker compose --env-file .env -f infra/docker/docker-compose.yml ps coturn freeswitch proxy
docker compose --env-file .env -f infra/docker/docker-compose.yml logs --tail=100 coturn
docker compose --env-file .env -f infra/docker/docker-compose.yml exec -T freeswitch \
  sh -lc 'fs_cli -H 127.0.0.1 -P 8021 -p "$FREESWITCH_ESL_PASSWORD" -x "sofia status profile internal-webrtc"'
```

Confirm the live FreeSWITCH profile advertises the Elastic IP, Coturn logs its public/private mapping and TLS listener, and browser `chrome://webrtc-internals` shows a successful `relay` candidate when direct UDP is blocked.
