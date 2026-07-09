# Refactoring Plan

This plan is based on the July 2026 audit of the API, FreeSWITCH event handling, and web softphone surface.

## Current Safety Net

- API tests now run through the built-in Node test runner with a separate `dist-test` output.
- Covered areas:
  - CSV parsing edge cases.
  - Phone normalization.
  - Manual dial validation with campaign permissions.
  - Strict campaign selection for dialer actions.
  - Missing trunk originate cleanup.
  - ESL dial string and response parsing.
  - FreeSWITCH event state mapping, including `CHANNEL_DESTROY`.
- Verification commands:
  - `npm --workspace @outbound-dialer/api test`
  - `npm test`
  - `npm run typecheck`
  - `npm run build`

## Phase 1: Stabilize Call State Invariants

Goal: make it impossible for backend-controlled calls to stay active without a real telephony path.

- Move active-call checks, contact selection, call creation, agent status updates, and contact status updates into one transaction.
- Use `for update skip locked` when selecting the next callable contact.
- Add partial unique indexes for active calls:
  - one active call per agent.
  - one active call per contact.
- Keep the current missing-trunk behavior: attempted calls must immediately become `failed`, release the agent, and reset the contact.
- Keep the state-aware originate watchdog:
  - early check validates agent leg.
  - customer leg is checked only after the agent-leg phase.
- Treat `CHANNEL_DESTROY` as a terminal call event when no hangup event has closed the call.

## Phase 2: Split Backend Modules

Goal: make `apps/api/src/dashboard/routes.ts` small enough to reason about and test.

Suggested modules:

- `dashboard/campaigns.ts`: campaign lookup, strict selected campaign lookup, campaign updates.
- `dashboard/manual-dial.ts`: validation, suppression checks, manual dialing policy.
- `dashboard/calls.ts`: create/end/drop voicemail/DTMF workflows.
- `dashboard/csv.ts`: CSV parsing and import persistence.
- `dashboard/recordings.ts`: recording upload, duration detection, default selection, audio serving.
- `dashboard/responders.ts`: response builders for agent desk/admin overview.

Move behavior only after tests exist for the extracted function. Avoid changing SQL and extraction in the same commit unless the test explicitly covers the behavior.

## Phase 3: Remove Demo Data From API Responses

Goal: production API should never mask real empty states.

- Remove demo campaign, demo leads, and demo active call fallbacks from `buildAgentDeskResponse`.
- Return explicit empty states when there is no active campaign or no callable leads.
- Add tests proving an empty DB does not return demo IDs or demo phone numbers.

## Phase 4: Fix Registration And Provisioning Ownership

Goal: softphone status should describe the current user and the generated FreeSWITCH directory should match DB state.

- Scope server-side `agent_registered` to the current user or remove it from the API and rely on browser SIP.js runtime state.
- Persist/register status from actual FreeSWITCH registration events if server-side status remains.
- Recreate the agent XML directory file when existing credentials are returned but the XML file is missing.
- Delete generated FreeSWITCH agent XML when a user/agent is deleted, then reload or flush the affected registration state.

## Phase 5: Web Reliability And Test Harness

Goal: make async UI state deterministic and testable.

- Add Vitest, jsdom, and React Testing Library for web tests.
- Introduce a typed `ApiError` with HTTP status in `apps/web/src/api.ts`.
- On 401 during polling, clear token/session instead of leaving stale desk state.
- Add latest-request guards or `AbortController` for:
  - active-call polling.
  - campaign contacts search/filter requests.
- Clear SIP registration timeout on reject/failure and keep remote audio cleanup on session termination.
- Remove unused `SoftphonePanel` and legacy `ManualDial` after the current `ManualDialSurface` has component coverage.
- Decide whether the manual dial "Lead name or note" field should be persisted. If not, remove it from the UI.

## Phase 6: Deployment Surface Cleanup

Goal: direct container ports and proxied production paths should behave consistently.

- Either remove public exposure of the web container port or add `/api/` proxying to `apps/web/nginx.conf`.
- Add a smoke test for the published web port if it remains exposed.
- Keep outer proxy behavior as the production source of truth for `/api`, WSS, and static SPA routing.

## Suggested Order

1. Add DB-level active-call/contact constraints and transactional call selection.
2. Extract and test call orchestration helpers.
3. Remove demo API fallbacks.
4. Add web test harness and typed API errors.
5. Clean up softphone registration/provisioning ownership.
6. Remove unused UI components and finish deployment smoke tests.
