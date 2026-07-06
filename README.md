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
- `packages/shared` - shared call state, outcome, role, and health contracts.
- `apps/api/db/migrations` - initial PostgreSQL schema for users, agents, campaigns, contacts, calls, call events, recordings, suppression, settings, and VM/beep signal events.
- `infra/docker/docker-compose.yml` - PostgreSQL, API, and FreeSWITCH services.
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
- `PUBLIC_APP_URL`
- `FREESWITCH_DOMAIN`
- Maxo trunk values once the provider details are available.

Deploy:

```bash
./scripts/deploy.sh
```

The API exposes:

```text
GET /health
```

Health output includes PostgreSQL and FreeSWITCH ESL connectivity. The ESL check can be temporarily disabled with `FREESWITCH_ESL_ENABLED=false` while FreeSWITCH runtime configuration is still being finalized.
