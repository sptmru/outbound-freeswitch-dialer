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

This repository currently contains planning documents only. Implementation should start from the architecture and delivery plan above.
