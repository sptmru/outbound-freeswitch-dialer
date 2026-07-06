# AI Development Workflow

## Purpose

This project will be built with AI assistance, but telephony systems fail in concrete ways. The workflow should keep implementation grounded in observable behavior, reproducible tests, and small verified changes.

## Working Agreement

- Keep docs, code, tests, and runtime evidence aligned.
- Prefer small vertical slices over broad speculative scaffolding.
- Before code changes in this repo, check durable project knowledge when available.
- Preserve exact route names, environment variable names, event names, FreeSWITCH commands, and SIP identifiers.
- Treat logs, ESL events, SIP traces, and database rows as primary evidence.
- Do not mark telephony behavior complete until it has been validated through a real or realistic call path.

## Development Loop

1. Define the target behavior in the plan or an issue.
2. Identify the call-state transition or user workflow affected.
3. Implement the narrowest useful slice.
4. Add or update tests for the behavior.
5. Run local verification.
6. Capture runtime evidence for telephony changes:
   - API logs.
   - ESL events.
   - FreeSWITCH logs when needed.
   - Database rows.
7. Update docs if setup, operations, or behavior changed.
8. Save durable knowledge for meaningful debugging, integration, deployment, or architecture outcomes.

## Suggested Task Template

```md
## Goal

## User-visible behavior

## Backend/state behavior

## FreeSWITCH/ESL behavior

## Data changes

## Tests

## Manual verification

## Docs to update

## Risks
```

## Definition Of Done

A task is done when:

- Code is implemented.
- Relevant tests pass.
- The expected call-state transitions are visible.
- Logs include correlation IDs.
- Docs are updated if any setup or behavior changed.
- Any unresolved risk is documented.

For telephony tasks, done also requires one of:

- A real call validation.
- A local SIP/WebRTC validation.
- A documented reason why validation is blocked.

## AI-Specific Guardrails

- Do not invent FreeSWITCH behavior when it can be tested.
- Do not rely on frontend state as the source of truth for calls.
- Do not hide uncertain telephony behavior behind UI polish.
- Do not create broad abstractions before the first working call path.
- Do not skip race-condition handling for hangup/drop-voicemail flows.
- Keep generated code idiomatic TypeScript and aligned with the repo's established patterns once code exists.

## Evidence To Keep

For each meaningful telephony milestone, keep:

- Commit SHA.
- Environment or compose profile used.
- Exact call path tested.
- Relevant API request.
- ESL commands issued.
- Key ESL events received.
- Final database call record.
- Any FreeSWITCH or SIP errors.

## Recommended Early Spikes

1. FreeSWITCH WebRTC registration from the browser.
2. Backend ESL connection and command execution.
3. Backend-originated call to an agent endpoint.
4. Backend-originated customer leg through a test SIP target.
5. Agent/customer bridge.
6. Customer-leg voicemail playback while releasing the agent leg.

These spikes should be kept small and converted into production code only after their behavior is understood.
