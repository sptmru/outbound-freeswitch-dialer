# Design Plan

## Design Goal

Create a quiet, operational Web UI that helps agents complete calls quickly and safely. The interface should prioritize call state clarity, fast click-to-call, and a reliable manual voicemail-drop workflow.

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
   - Live status timeline.
4. Design operational states:
   - Softphone unregistered.
   - Microphone permission missing.
   - Agent unavailable.
   - Dialing.
   - Ringing.
   - Bridged.
   - Voicemail playback starting.
   - Agent released.
   - Call completed.
   - Call failed.
5. Design admin screens:
   - Recordings list.
   - Recording upload/edit.
   - Users and roles.
   - Call history.
   - Per-call event timeline.
   - Suppression list if in scope.
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
  - Contacts or lead queue.
  - Call action per contact.
  - Current call panel.
- Current call panel:
  - Contact name and phone number.
  - Call state.
  - Timer.
  - Hangup.
  - Drop voicemail.
  - Selected recording.
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
- `releasing_agent`
- `released_after_voicemail`
- `failed`

The UI should expose these states as operational signals, not as developer jargon.

## Admin Scope

### Recordings

- Upload prerecorded voicemail audio.
- Validate visible status:
  - Processing.
  - Ready.
  - Failed.
  - Disabled.
- Preview recording.
- See usage in calls.

### Users

- Add/edit/deactivate agents.
- Assign role.
- See agent registration status.

### Call History

- Filter by agent, date, outcome, and voicemail drop.
- Open per-call timeline.
- Inspect failure reason and leg-level hangup causes.

## UX Rules

- The primary call action should be visually clear but not oversized.
- "Drop Voicemail" should only be available when a customer leg is active.
- Use confirmation or recording selection before dropping voicemail if multiple recordings exist.
- Do not show backend-ineligible actions as available.
- Failure messages should describe what the agent can do next.
- Admin screens should be dense, scannable, and operational rather than marketing-like.

## Design Deliverables

- Figma file URL.
- Agent dashboard frame.
- Admin frames.
- Component set for buttons, inputs, badges, status indicators, and call controls.
- State matrix matching backend call states.
- Implementation notes for frontend components.

## Design Acceptance Criteria

- Agent can understand the current call state at a glance.
- Agent can complete click-to-call and voicemail drop without reading documentation.
- UI state maps directly to backend call-state transitions.
- Admin can manage recordings without filesystem access.
