# ADR 0003 - Near-Term UX Scope

## Status

Accepted.

## Context

The first usability audit identified broader workflows for administrator access, post-call dispositions, and CSV field mapping. Client requirements for those workflows are not yet confirmed, so the near-term implementation should stay focused on the current operational MVP.

## Decision

- Admins primarily manage the system, but they may continue to access Agent Desk.
- The browser softphone and microphone should only start when the user is on Agent Desk, not while an admin is using management screens.
- Call outcomes remain automatically determined from the call lifecycle. A mandatory agent-selected disposition is not part of the current workflow.
- CSV import supports the current `name` and `phone` contract. Interactive preview and field mapping are deferred.
- Usability work should prioritize accurate automatic outcome visibility, state-eligible call controls, clear call history, and removal of misleading demo or implementation-specific UI data.

## Rationale

This keeps the product useful for the current client workflow without committing to larger data-mapping or agent wrap-up features before the client validates them.

## Consequences

- Admin access to Agent Desk remains supported.
- Admin management pages do not need softphone registration or microphone permission.
- Automatic outcome mapping and call-history detail become more important because agents do not enter dispositions manually.
- CSV failures should clearly explain missing or invalid `name` and `phone` values.
- Post-call notes, callbacks, manual disposition overrides, and flexible CSV mapping remain future decisions.

## Alternatives Considered

- Restrict Agent Desk to agent-role users only.
- Require an agent-selected outcome after every call.
- Build a CSV preview and mapping wizard immediately.
