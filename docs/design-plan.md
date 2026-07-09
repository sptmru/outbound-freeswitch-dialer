# Design Plan

## Design Goal

Create a quiet, operational Web UI that helps agents complete calls quickly and safely. The interface should prioritize call state clarity, fast click-to-call, and a reliable manual voicemail-drop workflow.

The first version is single-tenant and has no existing brand guide, so the design should establish a restrained operational visual system rather than a marketing look.

## Figma Workflow

Figma will be used as the source for visual design before implementation of production UI screens.

### Steps

1. Create a Figma file for the outbound dialer product.
2. Define design tokens:
   - Color roles.
   - Typography.
   - Spacing.
   - Button and input sizes.
   - Call-state colors.
3. Design the core agent workflow first:
   - Agent dashboard.
   - Contact/call target row.
   - Embedded softphone.
   - Active call controls.
   - Drop voicemail button and confirmation/recording selection.
   - Full lead information panel.
   - VM/beep detection signal indicator.
   - Live status timeline.
4. Design operational states:
   - Softphone unregistered.
   - Microphone permission missing.
   - Agent unavailable.
   - Dialing.
   - Ringing.
   - Bridged.
   - VM/beep signal detected.
   - Voicemail playback starting.
   - Agent released.
   - Call completed.
   - Call failed.
5. Design admin screens:
   - Campaigns.
   - CSV import for the current `name` and `phone` contract.
   - Recordings list.
   - Recording upload/edit.
   - Users and roles.
   - Call history.
   - Per-call event timeline.
   - Suppression list.
   - System settings for manual dialing and call recording.
6. Review designs against implementation constraints:
   - The frontend cannot directly originate PSTN calls.
   - UI actions must map to backend-authorized state transitions.
   - Call controls must be disabled when the backend would reject them.
7. Implement screens using shared design tokens and reusable components.
8. Compare implemented UI with Figma screenshots before acceptance.

## Agent Dashboard Scope

Primary layout:

- Top status bar:
  - Agent identity.
  - Softphone registration.
  - Microphone status.
  - Current availability.
- Main work area:
  - Campaign selector.
  - Contacts or lead queue.
  - Call action per contact.
  - Current call panel.
- Current call panel:
  - Contact name and phone number.
  - Additional imported lead fields when supported by the active CSV contract.
  - Call state.
  - Timer.
  - Hangup.
  - Drop voicemail.
  - Selected recording.
  - VM/beep detection signal if available.
  - Call recording indicator if enabled.
  - Event/status messages.
- Recent outcomes:
  - Last calls.
  - Disposition.
  - Voicemail drop marker.

## Softphone States

- `unregistered`
- `registering`
- `registered`
- `incoming_agent_leg`
- `connecting_customer`
- `in_call`
- `vm_beep_signal_detected`
- `releasing_agent`
- `released_after_voicemail`
- `failed`

The UI should expose these states as operational signals, not as developer jargon.

## Admin Scope

### Campaigns

- Create/edit/pause/archive campaigns.
- See campaign call counts and outcomes.
- Configure whether manual dialing is allowed if the setting is campaign-scoped.
- Configure whether call recording is enabled if the setting is campaign-scoped.

### CSV Imports

- Upload CSV files.
- Import the current `name` and `phone` contract directly.
- Validate phone numbers.
- Review import errors.
- Defer preview, interactive field mapping, and reusable mappings until client CSV samples require them.

### Recordings

- Upload prerecorded voicemail audio.
- Accept WAV/MP3 and show processing/transcoding state.
- Validate visible status:
  - Processing.
  - Ready.
  - Failed.
  - Disabled.
- Preview recording.
- Mark one recording as global default.
- See usage in calls.

### Users

- Add/edit/deactivate agents.
- Assign role.
- See agent registration status.
- Allow admins to open Agent Desk, while avoiding microphone and softphone startup on management screens.

### Call History

- Filter by campaign, agent, date, outcome, voicemail drop, VM/beep detected, and suppressed calls.
- Open per-call timeline.
- Inspect failure reason and leg-level hangup causes.
- Inspect call recording metadata when enabled.

### Suppression List

- Import suppression entries.
- Add/remove a number manually.
- Search by number.
- See when a call was blocked by suppression.

### System Settings

- Enable/disable manual dialing.
- Enable/disable call recording if global.
- Show trunk status and deployment/runtime health without exposing secrets.

## UX Rules

- The primary call action should be visually clear but not oversized.
- "Drop Voicemail" should only be available when a customer leg is active.
- Use confirmation or recording selection before dropping voicemail if multiple recordings exist.
- Use the global default recording by default.
- VM/beep detection should be visible as a signal, not as an automatic instruction.
- Do not show backend-ineligible actions as available.
- Manual number entry should disappear or be disabled when admin settings disable it.
- Failure messages should describe what the agent can do next.
- Admin screens should be dense, scannable, and operational rather than marketing-like.

## Design Deliverables

- Figma file URL: https://www.figma.com/design/o8J7yyhE8vY9HWLETUZ5O9
- Agent dashboard frame.
- Admin frames.
- Campaign and CSV mapping frames.
- Component set for buttons, inputs, badges, status indicators, and call controls.
- State matrix matching backend call states.
- Implementation notes for frontend components.

## Current Figma v1 Board

The first client-review board is `Outbound Dialer - Client Design v1`:

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

The board is designed as a product walkthrough: import CSV leads, call a lead, surface VM/beep signal, drop voicemail, release the agent, finish playback, and log the automatic outcome.

Applied revisions before client review:

- Remove TLS and trunk/provider setup settings from visible UI.
- Remove implementation-specific terms from UI copy.
- Add Login.
- Add Agent Desk idle/no-live-call state.
- Add Agent Desk manual-dialing-enabled state.
- Remove the `single tenant workspace` sidebar subtitle.

## Design Acceptance Criteria

- Agent can understand the current call state at a glance.
- Agent can complete click-to-call and voicemail drop without reading documentation.
- UI state maps directly to backend call-state transitions.
- Admin can manage recordings without filesystem access.
- Admin can import CSV leads containing `name` and `phone` without developer help.
- Admin can manage campaigns, suppression entries, users, and call-recording/manual-dialing settings.
