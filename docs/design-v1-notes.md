# Design v1 Notes

Figma file: https://www.figma.com/design/o8J7yyhE8vY9HWLETUZ5O9

## Purpose

This first board is meant for client review before backend implementation starts. It shows the product workflow and admin surfaces implied by the confirmed requirements, not final visual polish.

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
2. Admin maps CSV fields to lead fields.
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

## Known Follow-Ups

- Review with client and collect feedback.
- Decide whether call recording controls are global or campaign-level.
- Decide exact VM/beep confidence labels.
- Add final branding if client provides any.
- Refine visual details before frontend implementation.

## Applied Revisions

Status: applied in Figma.

- Remove TLS settings from the UI.
- Remove trunk/provider setup settings from the UI.
- Add an agent screen for the idle/no-live-call state, with a clear way to start the next call.
- Add an agent screen where manual dialing is enabled.
- Remove technical implementation details from visible UI copy, including references like FreeSWITCH, SIP, WebRTC, WSS, ESL, provider trunk setup, and similar internal terms.
- Add a login screen.
- Remove the `single tenant workspace` subtitle from the sidebar.
