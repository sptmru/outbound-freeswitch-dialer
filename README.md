# Outbound Dialer

Outbound dialer with a Web UI softphone, backend-owned call control, FreeSWITCH ESL, Docker, Node.js, and TypeScript.

The product target is an agent dashboard that supports click-to-call, live call state, manual voicemail drop, prerecorded audio playback into the customer leg, and agent release once playback starts.

## Planning Documents

- [Implementation plan](docs/implementation-plan.md) - end-to-end delivery plan from discovery to production handover.
- [Requirements](docs/requirements.md) - confirmed product and deployment decisions.
- [Architecture](docs/architecture.md) - proposed system architecture, call-control model, and call flows.
- [Design plan](docs/design-plan.md) - Figma-first product design workflow and UI scope.
- [AI development workflow](docs/ai-development-workflow.md) - how AI-assisted implementation should be run safely and repeatably.
- [Open questions](docs/open-questions.md) - remaining unknowns after the first scope clarification.
- [ADR 0001](docs/adr/0001-initial-architecture.md) - initial architecture decision record.
- [ADR 0002](docs/adr/0002-product-scope-decisions.md) - first product-scope decisions after requirement clarification.

## Proposed Repository Shape

```text
apps/
  api/                 # Node.js TypeScript backend, REST/WebSocket API, ESL orchestration
  web/                 # Agent/admin Web UI with embedded WebRTC softphone
packages/
  shared/              # Shared TypeScript types, validation schemas, call-state contracts
infra/
  docker/              # Compose files and container entrypoints
  freeswitch/          # FreeSWITCH profiles, dialplans, vars, recordings mount docs
docs/
  adr/                 # Architecture decision records
```

## Backend Foundation

The first backend slice is now scaffolded:

- `apps/api` - Fastify + TypeScript API with `/health`.
- `apps/web` - React + Vite operator UI based on the Figma v1 Agent Desk and admin flows.
- `packages/shared` - shared call state, outcome, role, and health contracts.
- `apps/api/db/migrations` - initial PostgreSQL schema for users, agents, campaigns, contacts, calls, call events, recordings, suppression, settings, and VM/beep signal events.
- `infra/docker/docker-compose.yml` - PostgreSQL, API, Web UI, HTTPS proxy, certbot, FreeSWITCH, and fail2ban services. FreeSWITCH runs with `network_mode: host` so SIP, WSS, and RTP bind directly on the deployment host.
- `scripts/deploy.sh` - Docker deployment entrypoint using `.env`.

## Local Setup

Install dependencies and build:

```bash
npm install
npm run build
```

Validate the Docker Compose file against the example env:

```bash
APP_ENV_FILE="$(pwd)/.env.example" docker compose --env-file .env.example -f infra/docker/docker-compose.yml config
```

## Docker Deployment

Create a real env file:

```bash
cp .env.example .env
```

Fill the required values in `.env`, especially:

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `FREESWITCH_ESL_PASSWORD`
- `JWT_SECRET`
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`
- `PUBLIC_APP_URL`
- `FREESWITCH_DOMAIN`
- `LETSENCRYPT_DOMAIN`
- `LETSENCRYPT_EMAIL`
- Maxo trunk values once the provider details are available.

Deploy:

```bash
./scripts/deploy.sh
```

The API exposes:

```text
GET /health
POST /auth/login
GET /auth/me
GET /agent/desk
POST /agent/manual-dial/validate
GET /admin/overview
POST /admin/campaigns
POST /admin/contacts
POST /admin/campaigns/:campaignId/import-csv
POST /admin/suppression
```

The Web UI is served by the `web` container and published through the `proxy`
container. Production UI traffic should use:

```text
https://<LETSENCRYPT_DOMAIN>
```

The proxy also forwards API requests under:

```text
https://<LETSENCRYPT_DOMAIN>/api/*
```

By default the internal `web` service is also exposed for local checks at:

```text
http://127.0.0.1:8080
```

Set `WEB_PUBLIC_PORT` to change that direct host port. For deployed builds,
keep `VITE_API_BASE_URL=/api` so the browser uses the same HTTPS origin as the
UI.

`./scripts/deploy.sh` starts the proxy, runs certbot with the webroot challenge
for `LETSENCRYPT_DOMAIN`, and reloads nginx after the certificate is issued.
The proxy starts with a short-lived self-signed fallback certificate only so the
container can boot before the first Let's Encrypt certificate exists.

Certificate renewal is handled by `scripts/renew-cert.sh`. The deploy script
installs a daily cron entry through `scripts/install-cert-renew-cron.sh`; renewal
logs are written to `logs/cert-renew.log`.

Health output includes PostgreSQL and FreeSWITCH ESL connectivity. The ESL check can be temporarily disabled with `FREESWITCH_ESL_ENABLED=false` while FreeSWITCH runtime configuration is still being finalized.

FreeSWITCH is started in host network mode. Keep `FREESWITCH_ESL_HOST=host.docker.internal` for the API container unless the API is also moved to host networking.
The default `FREESWITCH_ESL_ACL=any_v4.auto` allows the API container to reach host-mode ESL; restrict host firewall access to port `8021` in production.

Auth endpoints:

```text
POST /auth/login
GET /auth/me
POST /admin/users
```

`BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` create the first admin account on startup if it does not already exist. Creating a user with `role: "agent"` automatically creates SIP credentials and returns the SIP password once in the response.

Agent SIP directory files are rendered into the shared `freeswitch_generated` Docker volume. The API writes files under `directory/default`, and the FreeSWITCH wrapper image links that path into `/etc/freeswitch/directory/default` before startup.

FreeSWITCH runtime config is rendered at container startup from templates in `infra/freeswitch/templates`:

- ESL password and ACL.
- Global domain, RTP range, and advertised SIP/RTP IPs.
- Internal WebRTC SIP profile.
- Optional Maxo registration gateway when `MAXO_TRUNK_MODE=registration` and trunk credentials are present.
- IP-auth outbound routing skeleton for `MAXO_TRUNK_MODE=ip_auth`.
- Manual voicemail-drop dialplan context.

Fail2ban runs as a separate host-network container and watches FreeSWITCH logs
for SIP scanner noise such as `Can't find user [...] from <ip>`. The jail lives
in `infra/fail2ban` and bans matching IPs after repeated misses.
