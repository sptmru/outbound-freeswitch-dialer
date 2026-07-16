# Design v1 Notes

Figma file: https://www.figma.com/design/o8J7yyhE8vY9HWLETUZ5O9

## Purpose

This is the historical first client-review board. It shows the original product workflow and admin surfaces; the implemented application and current requirements are now the source of truth where they differ from the board.

## Screens Included

- Cover / Design overview.
- Login.
- Agent Desk.
- Agent Desk - Ready.
- Agent Desk - Manual Dialing.
- Voicemail Drop.
- Campaigns and CSV Import.
- Recordings and Users.
- Call History and Operations.
- Settings and Suppression.

## Product Story Shown

1. Admin imports a CSV.
2. Admin validates the required `name` and `phone` columns and reviews row errors.
3. Agent calls a lead from a campaign queue.
4. UI surfaces VM/beep detection as a signal.
5. Agent manually starts Drop Voicemail.
6. Backend releases the agent leg after voicemail playback starts.
7. Customer leg hangs up after playback completes.
8. Outcome and support timeline are logged.

## Design Direction

- Operational B2B dashboard, not a marketing site.
- Dense but readable layouts.
- Explicit call state and telephony state.
- Admin workflows visible enough for handover discussion.
- VM/beep detection shown as an informational signal, not automation.
- Suppression and support artifacts visible as first-class operational concerns.

## Current Follow-Ups And Resolved Scope

- Review the implemented UI with the client, collect feedback, and add final branding if provided.
- CSV import is a direct `name` + `phone` workflow; interactive field mapping remains deferred.
- Call recording and manual dialing controls are campaign-level.
- VM/beep evidence remains advisory; runtime validation should determine whether the visible labels need further calibration.

## Applied Revisions

Status: applied in Figma.

- Remove TLS settings from the UI.
- Remove trunk/provider setup settings from the UI.
- Add an agent screen for the idle/no-live-call state, with a clear way to start the next call.
- Add an agent screen where manual dialing is enabled.
- Remove technical implementation details from visible UI copy, including references like FreeSWITCH, SIP, WebRTC, WSS, ESL, provider trunk setup, and similar internal terms.
- Add a login screen.
- Remove the `single tenant workspace` subtitle from the sidebar.
