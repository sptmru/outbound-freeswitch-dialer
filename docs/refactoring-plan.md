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
  - Call creation failure messages.
  - Transactional active-call/contact selection.
  - Recording helper behavior: extension detection, multipart fields, content types, name normalization, and WAV duration detection.
  - ESL dial string and response parsing.
  - FreeSWITCH event state mapping, including `CHANNEL_DESTROY`.
  - FreeSWITCH generated agent XML recreation/deletion.
- Verification commands:
  - `npm --workspace @outbound-dialer/api test`
  - `npm --workspace @outbound-dialer/web test`
  - `npm test`
  - `npm run typecheck`
  - `npm run build`

## Completed Refactors

- Phase 1 backend call-state invariants:
  - active-call checks now run inside the call creation transaction.
  - `call-next` contact selection uses `for update skip locked`.
  - selected lead calls revalidate and lock the contact before call creation.
  - active call uniqueness is backed by partial DB indexes.
- Phase 4 provisioning lifecycle:
  - server-side `agent_registered` is scoped to the current user.
  - existing agent softphone provisioning recreates missing generated XML before returning credentials.
  - user deletion removes generated agent XML after DB commit.
- Phase 5 web reliability cleanup:
  - web API errors carry HTTP status.
  - active-call polling ignores stale responses.
  - 401 polling responses clear the session.
  - campaign contact search/filter ignores stale responses.
  - unused legacy softphone/manual dial components were removed.
  - the non-persisted manual dial note field was removed.
  - Vitest, jsdom, and React Testing Library were added for web tests.
  - Agent Desk no-campaign and empty-lead states are covered by web tests.
- Phase 6 deployment surface cleanup:
  - direct web nginx now proxies `/api/` to the API service instead of serving the SPA fallback.
- Phase 2 backend module split:
  - `apps/api/src/dashboard/routes.ts` was reduced from 3726 lines to 1393 lines.
  - phone normalization moved to `dashboard/phone.ts`.
  - CSV parsing/import persistence moved to `dashboard/csv.ts`.
  - campaign lookup/deletion helpers moved to `dashboard/campaigns.ts`.
  - manual dial validation moved to `dashboard/manual-dial.ts`.
  - suppression lookup moved to `dashboard/suppression.ts`.
  - call orchestration moved to `dashboard/calls.ts`.
  - recording persistence/default/audio metadata/duration helpers moved to `dashboard/recordings.ts`.
  - agent/admin response builders moved to `dashboard/responders.ts`.
- Phase 3 demo data removal:
  - `AgentDeskResponse.campaign` can now be `null` when there is no active campaign.
  - agent desk responses return empty leads/metrics instead of demo campaign, demo leads, or demo active call data.
  - the web Agent Desk renders an explicit no-campaign empty state.

## Phase 1: Stabilize Call State Invariants

Goal: make it impossible for backend-controlled calls to stay active without a real telephony path.

- Done: move active-call checks, contact selection, call creation, agent status updates, and contact status updates into one transaction.
- Done: use `for update skip locked` when selecting the next callable contact.
- Done: add partial unique indexes for active calls:
  - one active call per agent.
  - one active call per contact.
- Keep the current missing-trunk behavior: attempted calls must immediately become `failed`, release the agent, and reset the contact.
- Keep the state-aware originate watchdog:
  - early check validates agent leg.
  - customer leg is checked only after the agent-leg phase.
- Treat `CHANNEL_DESTROY` as a terminal call event when no hangup event has closed the call.

## Phase 2: Split Backend Modules

Goal: make `apps/api/src/dashboard/routes.ts` small enough to reason about and test.

Completed modules:

- Done: `dashboard/phone.ts`: phone normalization.
- Done: `dashboard/csv.ts`: CSV parsing and import persistence.
- Done: `dashboard/campaigns.ts`: campaign lookup, strict selected campaign lookup, campaign deletion helpers.
- Done: `dashboard/manual-dial.ts`: validation, suppression checks, manual dialing policy.
- Done: `dashboard/suppression.ts`: shared suppression lookup.
- Done: `dashboard/calls.ts`: create/end/drop voicemail/DTMF workflows.
- Done: `dashboard/recordings.ts`: recording persistence, default selection, audio metadata, content-type, and duration helpers.
- Done: `dashboard/responders.ts`: response builders for agent desk/admin overview.

Remaining backend splits:

- contact/suppression mutation handlers if they keep growing.
- optional Fastify route grouping if route registration keeps growing.

Move behavior only after tests exist for the extracted function. Avoid changing SQL and extraction in the same commit unless the test explicitly covers the behavior.

## Phase 3: Remove Demo Data From API Responses

Goal: production API should never mask real empty states.

- Done: remove demo campaign, demo leads, and demo active call fallbacks from `buildAgentDeskResponse`.
- Done: return explicit empty states when there is no active campaign or no callable leads.
- Done: add tests proving an empty DB does not return demo IDs or demo phone numbers.

## Phase 4: Fix Registration And Provisioning Ownership

Goal: softphone status should describe the current user and the generated FreeSWITCH directory should match DB state.

- Done: scope server-side `agent_registered` to the current user.
- Persist/register status from actual FreeSWITCH registration events if server-side status remains.
- Done: recreate the agent XML directory file when existing credentials are returned but the XML file is missing.
- Done: delete generated FreeSWITCH agent XML when a user/agent is deleted.
- Follow-up: add a narrow ESL-backed reload/flush path for deleted agent registrations after the local generated XML cleanup is covered (`reloadxml` and/or the affected `sofia` registration state).

## Phase 5: Web Reliability And Test Harness

Goal: make async UI state deterministic and testable.

- Done: add Vitest, jsdom, and React Testing Library for web tests.
- Done: cover Agent Desk no-campaign and empty-lead states in web tests.
- Done: introduce a typed `ApiError` with HTTP status in `apps/web/src/api.ts`.
- Done: on 401 during polling, clear token/session instead of leaving stale desk state.
- Done: add latest-request guards for:
  - active-call polling.
  - campaign contacts search/filter requests.
- Clear SIP registration timeout on reject/failure and keep remote audio cleanup on session termination.
- Done: remove unused `SoftphonePanel` and legacy `ManualDial`.
- Done: remove the manual dial "Lead name or note" field because it was not persisted.

## Phase 6: Deployment Surface Cleanup

Goal: direct container ports and proxied production paths should behave consistently.

- Done: add `/api/` proxying to `apps/web/nginx.conf`.
- Add a smoke test for the published web port if it remains exposed.
- Keep outer proxy behavior as the production source of truth for `/api`, WSS, and static SPA routing.

## Suggested Order

1. Add ESL-backed reload/flush for deleted agent registrations.
2. Finish deployment smoke tests.
