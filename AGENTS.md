# AGENTS.md

Instructions for coding agents working in this repository. This file applies to the
entire repository unless a more specific `AGENTS.md` exists below the file being
changed.

## Project Overview

Outbound Dialer is a single-tenant outbound calling system built as an npm
workspace monorepo. The browser is an authenticated SIP/WebRTC media endpoint;
the Fastify API owns call control and durable state; FreeSWITCH owns SIP/RTP and
is controlled through ESL; PostgreSQL is the product source of truth.

Before changing behavior, read the relevant source-of-truth document:

- Product scope and requirements: `docs/requirements.md`
- Current implementation status: `docs/implementation-plan.md`
- System and call-flow design: `docs/architecture.md`
- Environment variables: `.env.example` and `docs/environment-configuration.md`
- Production operations: `docs/runbooks/`
- Accepted architecture decisions: `docs/adr/`

Do not treat plans or documentation as proof that an external SIP call, far-end
voicemail, restore, or production acceptance test has passed. Those claims need
runtime evidence from the target environment.

## Repository Map

- `apps/api/`: Fastify API, PostgreSQL access/migrations, ESL orchestration,
  metrics, retention, and media authorization.
- `apps/web/`: React/Vite Agent Desk and administrator UI, including SIP.js.
- `packages/shared/`: TypeScript contracts shared by API and web.
- `infra/freeswitch/`: repo-owned FreeSWITCH templates, dialplans, and runtime
  rendering. Do not patch generated container configuration as the durable fix.
- `infra/docker/docker-compose.yml`: the main product and monitoring deployment.
- `infra/proxy/`, `infra/coturn/`, `infra/pcap/`, `infra/fail2ban/`: supporting
  runtime components.
- `monitoring/`: Prometheus, Grafana, Loki, Alloy, Alertmanager, and exporters.
- `scripts/`: deployment, rollback, backup/restore, smoke, load, and telephony
  scenario tooling.
- `tests/`: operational and browser end-to-end tests.

## Required Preflight

Before editing an existing feature or fixing a bug:

1. Inspect `git status --short` and preserve unrelated user changes.
2. Search the Developer Knowledge Base (`qdrant-search`) using the task wording
   and `outbound-dialer` as the project/repository. Use `kb_find_symbol` first
   for exact routes, fields, env vars, functions, services, or protocol tokens.
   For runtime, SIP/media, deployment, or recurring bugs, also use
   `kb_find_similar_incidents`.
3. Read the relevant implementation and documentation files. Do not rely only
   on remembered repository behavior.
4. For meeting-derived requirements or decisions, consult Granola when it is
   available instead of reconstructing the discussion.

When asked to inspect runtime or deployment logs, use `codex-logs` first. Fall
back to narrowly scoped Docker or host commands only if that source is missing
or unavailable, and state the fallback.

## Working Rules

- Make the narrowest change that completes the real user workflow. Avoid broad
  refactors unless they are explicitly requested or required for correctness.
- Preserve exact route names, payload fields, event names, environment variable
  names, service names, SIP identifiers, and FreeSWITCH commands.
- Keep frontend state subordinate to API, database, and FreeSWITCH evidence for
  call lifecycle decisions.
- Treat hangup, reconnect, originate failure, voicemail handoff, retries, and
  duplicate/out-of-order ESL events as race-prone paths. Keep operations
  idempotent and terminal transitions explicit.
- Keep product UI action-first and avoid exposing telephony plumbing unless the
  user needs diagnostic detail.
- Normalize phone input before strict `libphonenumber-js` validation. Do not add
  permissive regex bypasses.
- Keep secrets out of source, logs, test fixtures, tickets, and responses. Never
  print a populated `.env`. `.env.example` is the canonical variable inventory.
- Generated monitoring files under `monitoring/generated/` are rendered by
  `scripts/deploy.sh`; update their sources, not generated output.
- Deployment remains `.env`-driven and uses the existing Docker Compose and
  `scripts/deploy.sh` path. Do not create a parallel deployment flow casually.
- Firewall policy and host-published port changes require explicit scope and
  deployment-owner review.
- Update tests with behavior changes and update docs when contracts, setup,
  operations, environment variables, or user-visible behavior change.

## Shared Contracts

API and web consume built output from `packages/shared/dist`. After changing a
shared contract, rebuild shared before focused API/web checks:

```bash
npm --workspace @outbound-dialer/shared run build
```

Keep shared contracts backward-compatible across rolling deployment and rollback
boundaries when practical. Database migrations are forward-only; rollback does
not reverse them.

## Validation

Node.js 22 or newer is required. Start with focused checks for the changed area,
then run the broadest safe gate proportional to the change.

```bash
# Focused workspace tests
npm --workspace @outbound-dialer/api test
npm --workspace @outbound-dialer/web test

# A single web test file (the workspace already runs from apps/web)
npm --workspace @outbound-dialer/web test -- src/App.test.tsx

# Full static, test, and build gate
npm run quality

# Patch hygiene
git diff --check
```

Environment-backed checks are separate and should run only when the required
services/configuration are available:

```bash
npm run test:e2e
npm run test:freeswitch
npm run test:load:desk
APP_ENV_FILE="$(pwd)/.env.example" docker compose --env-file .env.example \
  -f infra/docker/docker-compose.yml config
```

Do not claim an environment-backed check passed if it was skipped or blocked.
Report the exact command, result, and limitation.

## Telephony And Runtime Changes

For call-flow, SIP, RTP, recording, voicemail, or ESL work, trace the real path
before changing UI behavior. The fastest source files are typically:

- `apps/api/src/esl.ts`
- `apps/api/src/esl-events.ts`
- `apps/api/src/dashboard/routes.ts`
- `infra/freeswitch/templates/`
- recent `call_events` and correlated runtime logs

Capture evidence appropriate to the change: API correlation ID, ESL commands and
events, FreeSWITCH/SIP/RTP evidence, relevant database rows, and the terminal call
record. Clean recordings do not by themselves prove the browser WebRTC leg is
healthy. Do not declare telephony behavior complete without a real or realistic
call-path validation, or a clearly documented reason it could not be performed.

## Database And Operational Safety

- Follow the existing ordered migration pattern and make migrations safe for
  the currently deployed and immediately previous application versions.
- Do not edit production data, deploy, restart services, rotate secrets, restore
  backups, alter firewall rules, or publish changes without explicit user scope.
- Prefer read-only diagnosis first for incidents. Preserve current runtime
  evidence before rebuilding or restarting affected services.
- Never use destructive Git commands to discard local changes. Do not amend,
  commit, push, or open a PR unless the user asks.

## Completion And Durable Knowledge

A completed change includes implementation, relevant passing checks, updated
documentation where needed, and an explicit note about any unverified runtime
behavior or remaining risk.

At the end of substantial verified debugging, integration, deployment, or
architecture work, save a concise session summary to the Developer Knowledge
Base. Also save a structured incident, decision, or procedure when a confirmed
root cause, durable technical choice, or reusable runbook emerged. Include exact
paths, commands, identifiers, and git/PR provenance when available; never save
guesses or unverified hypotheses.
