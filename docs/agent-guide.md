# Agent Guide

## Start A Shift

1. Sign in and open **Agent Desk**.
2. Allow microphone access only when the browser requests it on Agent Desk.
3. Wait for the phone status to show connected and your availability to show **Ready**.
4. Select the correct active campaign and review the offered lead.

Use **Pause** whenever you should not start another call, including during an active call. Pausing does not affect the current call, but prevents an automatically advanced call from starting after it ends. Select **Resume calling** whenever you are ready again, including during the current call. Voicemail playback remains tracked in the background.

The page refreshes state from the server through live update signals and periodic fallback checks. If the display appears stale, do not repeat a call-control action; record the visible state and ask an administrator to verify the call.

## Call Workflow

- Use **Zoho CRM** beside a lead in **Next leads**, **Lead queue**, or **Lead context** during a call to open their CRM profile in a new tab. The link appears only when the lead has a `lead_id` from CSV import or manual entry. Sign in to Zoho with an account that has access to the profile.
- Use **Call** for the offered lead, or **Manual dial** only when the campaign permits it. Every destination is normalized and checked against suppression by the backend.
- The browser plays an immediate local ringing cue while call audio connects. It yields to carrier-provided ringback or announcements as soon as remote audio starts. When the carrier supplies no audible early media, FreeSWITCH continues with its own ringback fallback after a short delay. The operator remains responsible for deciding whether a human or mailbox answered after answer audio begins.
- Use the keypad for DTMF only when it is enabled.
- Use **Hang up** for the active interactive call. Outcomes are determined by backend lifecycle events; do not infer success from the timer or audio alone.
- A failed/retryable contact is not immediately callable again. The server enforces the configured attempt limit and delay.

## Drop Voicemail

1. Confirm the mailbox is ready.
2. Check the selected recording or accept the configured default.
3. Click **Drop voicemail** once.
4. Wait for the UI to show playback started and the agent released.

After release, the customer leg remains in the background job list until playback completes, fails, or is interrupted. You may start another interactive call while it is tracked. Do not report a successful delivery until the job is terminal, and remember that even local completion does not prove the far-end mailbox stored the full message.

## If Something Looks Wrong

- Do not repeatedly click **Call**, **Hang up**, or **Drop voicemail**.
- Record the visible call ID/state, campaign, UTC time, destination in masked form, and what audio you heard.
- Report registration failures, missing/one-way audio, missing ringback, DTMF failure, stale calls, incorrect outcomes, or stuck background jobs to the administrator.
- If voicemail is pending/failed/interrupted, do not tell the customer/team that delivery succeeded.
- Never share passwords, SIP details, media URLs, browser logs containing tokens, or unmasked customer numbers through an unapproved channel.
