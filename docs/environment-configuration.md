# Environment Configuration

## Configuration Contract

`.env.example` is the canonical inventory and safe-value template for a deployment. Copy it to a protected file, replace every placeholder, and validate it before starting containers:

```bash
cp .env.example .env
chmod 600 .env
./scripts/preflight.sh
```

The deployment scripts use repository-root `.env` unless `ENV_FILE` points to another absolute file. They source the file as shell syntax and also pass it to Docker Compose with `--env-file`, so values must be valid in both contexts. Quote values that contain spaces or shell metacharacters, as `BACKUP_CRON_SCHEDULE` does. Never commit the populated file or paste it into logs, tickets, or chat.

`scripts/deploy.sh` enforces mode `0600` on the selected `ENV_FILE` before running preflight. Running `scripts/preflight.sh` directly remains read-only and rejects broader permissions instead of changing them.

The runtime contract has three layers:

1. `scripts/preflight.sh` rejects unsafe production topology, secrets, provider, alert, backup, image, and rollback settings.
2. `infra/docker/docker-compose.yml` maps deployment values into containers and supplies operational defaults.
3. `apps/api/src/config.ts` parses API values, applies bounds/defaults, and performs an additional production-safety check.

Run the Compose-only check when editing the model or template values:

```bash
APP_ENV_FILE="$(pwd)/.env.example" docker compose --env-file .env.example \
  -f infra/docker/docker-compose.yml config --quiet
```

This proves interpolation only. Production deployment still requires `./scripts/preflight.sh` because the example intentionally contains placeholder secrets and example addresses.

## Production-Critical Groups

### Public URLs and TLS

| Variable                          | Purpose and constraint                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_APP_URL`                  | Canonical public application URL used by the API.                                                                |
| `CORS_ORIGINS`                    | Comma-separated allowed browser origins. Include the real public origin; do not use a wildcard with credentials. |
| `LETSENCRYPT_DOMAIN`              | Primary dialer hostname. nginx serves UI/API/WSS on its certificate.                                             |
| `GRAFANA_DOMAIN`                  | Separate Grafana hostname routed by the same nginx proxy.                                                        |
| `LETSENCRYPT_EMAIL`               | ACME registration/expiry contact.                                                                                |
| `FREESWITCH_WEBRTC_PUBLIC_WS_URL` | Browser SIP endpoint, normally `wss://<LETSENCRYPT_DOMAIN>/freeswitch-ws`.                                       |

Certificate automation issues one SAN certificate covering `LETSENCRYPT_DOMAIN` and `GRAFANA_DOMAIN`. Both DNS records must resolve to the deployment host before `scripts/ensure-cert.sh` runs.

### Secrets and identities

Production preflight requires independent, non-placeholder values for:

- `POSTGRES_PASSWORD` and the separately scoped `POSTGRES_EXPORTER_PASSWORD`;
- `JWT_SECRET` and `SIP_SECRET_ENCRYPTION_KEY`;
- `FREESWITCH_ESL_PASSWORD`;
- `TURN_SHARED_SECRET`;
- `GRAFANA_ADMIN_PASSWORD`;
- `BACKUP_ENCRYPTION_PASSPHRASE`;
- `BOOTSTRAP_ADMIN_PASSWORD` when `BOOTSTRAP_ADMIN_EMAIL` is set.

Do not reuse these values. `DATABASE_URL` must contain the same application database credentials as `POSTGRES_USER`/`POSTGRES_PASSWORD`. The exporter password is applied to the dedicated `outbound_dialer_exporter` role by deployment and restore workflows; it is not the application database password.

`SIP_SECRET_WRITE_VERSION` defaults to `v1`. Moving to `v2` is a staged deployment operation, not a fresh-install toggle; follow the [two-stage encryption rollout](runbooks/deployment.md#two-stage-sip-credential-encryption-rollout).

### FreeSWITCH, SIP trunk, and browser WSS

| Variable group                                                                 | Configuration rule                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `FREESWITCH_BASE_IMAGE`                                                        | Pin an immutable `@sha256` digest.                                                                 |
| `FREESWITCH_EXTERNAL_SIP_IP`, `FREESWITCH_EXTERNAL_RTP_IP`                     | Literal, matching public/Elastic IPv4 addresses for the current single-host topology.              |
| `FREESWITCH_RTP_START_PORT`, `FREESWITCH_RTP_END_PORT`                         | Dedicated UDP media range; it must not overlap the TURN relay range.                               |
| `FREESWITCH_INTERNAL_SIP_PORT`                                                 | Browser/internal SIP profile, default `5060`.                                                      |
| `FREESWITCH_EXTERNAL_PROFILE_SIP_PORT`, `FREESWITCH_EXTERNAL_PROFILE_TLS_PORT` | Provider-facing external profile, defaults `5080`/`5081`.                                          |
| `FREESWITCH_WEBRTC_WSS_PORT`                                                   | Host WSS listener, default `7443`; public browsers reach it through nginx.                         |
| `FREESWITCH_ESL_*`                                                             | API-to-FreeSWITCH control channel plus queue/retry/reconciliation bounds. ESL is not a public API. |
| `SIP_TRUNK_MODE`                                                               | `registration` requires proxy, username, and password; `ip_auth` requires the proxy.               |

nginx connects to the host-network FreeSWITCH listener using `FREESWITCH_WS_UPSTREAM_SCHEME` and `FREESWITCH_WS_UPSTREAM`. Prefer certificate verification with `FREESWITCH_WS_UPSTREAM_TLS_VERIFY=on` and the matching `FREESWITCH_WS_UPSTREAM_TLS_SERVER_NAME`. `ALLOW_UNVERIFIED_FREESWITCH_WS_UPSTREAM=true` is a recorded break-glass exception for an approved same-host/self-signed endpoint, not a general production default.

Keep `ALLOW_UNCONFIGURED_SIP_TRUNK=false` for a production dialer. Setting it to `true` acknowledges that customer calls cannot be accepted as working.

### STUN and TURN

| Variable                         | Purpose and constraint                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ICE_STUN_URLS`                  | Comma-separated browser STUN URLs.                                                                              |
| `TURN_URLS`                      | Comma-separated `turn:`/`turns:` URLs returned to the browser; production values must use `LETSENCRYPT_DOMAIN`. |
| `TURN_SHARED_SECRET`             | Server-side HMAC secret used to issue short-lived credentials; never expose it as a Vite/browser variable.      |
| `TURN_RELAY_IP`                  | Address assigned to the host interface: private IPv4 on AWS/NAT, public IPv4 on a directly addressed server.    |
| `TURN_PORT`, `TURN_TLS_PORT`     | Coturn listener ports, defaults `3478` and `5349`.                                                              |
| `TURN_MIN_PORT`, `TURN_MAX_PORT` | Dedicated relay range, default `49152-49252`; it must not overlap FreeSWITCH RTP.                               |
| `COTURN_IMAGE`                   | Immutable `@sha256` image reference required by preflight.                                                      |

Use [AWS NAT, firewall, STUN, and TURN](runbooks/aws-networking.md) for address selection, firewall rules, DNS, and live verification.

### Monitoring and alerting

`GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`, and the retention settings configure Grafana, Prometheus, Loki, and Alertmanager. At least one of `ALERTMANAGER_WEBHOOK_URL` or the Telegram token/chat pair should route alerts off the host. `ALLOW_NO_ALERT_RECEIVER=true` is an explicit production risk acceptance.

Monitoring is part of the main Compose deployment. `scripts/deploy.sh` renders `monitoring/generated/prometheus.yml` and `monitoring/generated/alertmanager.yml`, validates all monitoring configs with the pinned runtime images, then starts the stack. Do not edit generated files directly.

Set `COMPOSE_PROJECT_NAME` when deploying under a non-default project name. Alloy maps it to `MONITORING_COMPOSE_PROJECT` and uses it to avoid collecting logs from unrelated Compose projects on the host.

### Backups, retention, and media

| Variable group                                                          | Purpose                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `BACKUP_*`                                                              | Encrypted backup destination, retention, quiescing, and cron schedule. Production normally requires `BACKUP_S3_URI`.           |
| `CALL_LOG_RETENTION_DAYS`, `CALL_RECORDING_RETENTION_DAYS`              | Database call/event and recording retention windows.                                                                           |
| `RETENTION_ENABLED`, `RETENTION_RUN_INTERVAL_SECONDS`                   | API retention scheduler control.                                                                                               |
| `VOICEMAIL_UPLOAD_MAX_BYTES`, `PROXY_MAX_REQUEST_BODY_SIZE`             | Application upload limit and slightly larger nginx request limit.                                                              |
| `PCAP_CAPTURE_ENABLED`, `PCAP_CAPTURE_INTERFACE`, `PCAP_RETENTION_DAYS` | Per-call SIP/RTP capture with terminal SIP/media isolation. Leave disabled unless approved; captures contain customer traffic. |
| `MEDIA_TICKET_TTL_SECONDS`, `MEDIA_TICKET_MAX_LIFETIME_SECONDS`         | Short-lived scoped browser access to recordings/captures.                                                                      |

`ALLOW_LOCAL_ONLY_BACKUPS=true` and `ALLOW_NON_QUIESCED_BACKUP=true` are risk acknowledgements, not evidence of an accepted recovery design. Follow the [backup and restore runbook](runbooks/backup-restore.md).

## Admin Runtime Overrides

The Settings UI stores a bounded allowlist of product-policy overrides under `admin.runtime_settings` in PostgreSQL. The corresponding `.env` values remain defaults for a new database and fallback values when no override has been saved. The runtime-managed set is:

- `DEFAULT_PHONE_COUNTRY_CODE`, `CONTACT_MAX_ATTEMPTS`, `CONTACT_RETRY_DELAY_SECONDS`, and `CALL_HISTORY_EXPORT_MAX_ROWS`;
- `CALL_LOG_RETENTION_DAYS`, `CALL_RECORDING_RETENTION_DAYS`, `PCAP_RETENTION_DAYS`, and `RETENTION_ENABLED`;
- `PCAP_CAPTURE_ENABLED` and `SIP_TRUNK_CALLER_ID`;
- `ALERTMANAGER_REPEAT_INTERVAL` plus enablement of already configured webhook/Telegram receivers.

Alert receiver URLs/tokens remain deployment-managed secrets and are never returned by the settings API. Runtime alert changes update `monitoring/generated/alertmanager.yml` through the API's dedicated bind mount and use Alertmanager's lifecycle reload endpoint. Direct edits to generated files remain unsupported.

## Build-Time, Runtime, and Operator-Only Values

- `VITE_API_BASE_URL` and `VITE_SIP_DIAGNOSTICS` are baked into the web image during `docker compose build`; changing them requires rebuilding `web`.
- API, FreeSWITCH, Coturn, proxy, monitoring, and retention values are runtime container settings; `scripts/deploy.sh` recreates services as needed. The explicit admin override allowlist above is the exception and applies through the API.
- `APP_VERSION` is set by deploy/rollback scripts from the Git SHA and should not be maintained in `.env`.
- `ENV_FILE`, `DEPLOY_PULL`, `DEPLOY_NODE_VERSION`, `SKIP_DEPLOY_CHECKS`, `SKIP_PRE_DEPLOY_BACKUP`, and the `ALLOW_*` release overrides are operator controls. Pass them only for the documented procedure; do not normalize them into an ordinary production `.env`.
- `HTTP_PORT`, `HTTPS_PORT`, `API_PUBLIC_PORT`, and `WEB_PUBLIC_PORT` are host publications. The public path should use nginx on 80/443; restrict direct API/web ports at the host/network layer until they are removed from the deployment shape.

## Change Checklist

When adding or changing an environment value:

1. update `.env.example` with a safe placeholder/default and a concise comment;
2. update `apps/api/src/config.ts` if the API consumes it, including validation bounds;
3. map it in `infra/docker/docker-compose.yml` for the consuming service;
4. add a preflight assertion when a wrong value can make production unsafe;
5. update this guide or the relevant runbook when operator behavior changes;
6. run `npm run quality`, the Compose interpolation check, and `git diff --check`.
