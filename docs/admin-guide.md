# Administrator Guide

## Campaigns And Contacts

- Create a campaign in `draft`, review its contact data and policy, then activate it. Use `paused` to stop new calls temporarily and `archived` to preserve closed campaign history.
- Configure manual dialing, call recording, and early-media AVMD per campaign. These controls do not replace legal/provider approval.
- Import CSV with the intentionally narrow required `name` and `phone` columns. Review accepted/rejected/duplicate counts and row errors before activation.
- Search/filter contacts and verify that completed, suppressed, currently calling, exhausted, or retry-delay contacts are not offered as callable.
- Defaults are three committed attempts and a 15-minute retry delay. Change `CONTACT_MAX_ATTEMPTS`/`CONTACT_RETRY_DELAY_SECONDS` only after the operating policy is approved.

## Voicemail Recordings

- Upload one WAV or MP3 from **Recordings**. The API probes and transcodes it to mono 8 kHz signed 16-bit PCM WAV with loudness normalization; malformed/no-audio/over-five-minute input is rejected.
- Preview the canonical file, check duration/size, and keep one appropriate global default.
- Deactivation/removal preserves database references used by historical calls. Do not change the active library during a live voicemail test without recording the context.
- Playback in the browser uses short-lived media tickets. If a long-open player expires, retry playback to obtain a new ticket.

## Users And Sessions

- Create named accounts; never share agent/admin credentials.
- Edit name/email/role, reset passwords, and deactivate/reactivate through the supported UI/API.
- Password reset and deactivation revoke outstanding sessions. Deactivation is refused while the user has an active interactive call and removes the agent's FreeSWITCH registration material while preserving history.
- Do not use physical deletion or direct SQL to offboard users.

## Suppression

- Add/search normalized numbers, import an approved CSV, and keep a meaningful reason/source.
- Manual and campaign dialing are checked before originate.
- Creation/update/import/removal and blocked manual-dial attempts are preserved in `suppression_events`.
- Treat removal as a compliance-sensitive action: confirm the normalized number and retain the required source/evidence outside the current-entry table where policy demands it.

## History And Audit

- Filter call history by search text, campaign, agent, outcome, date, voicemail drop/signal, and recording availability.
- Open call detail for leg UUIDs, state events, commands, hangup causes, AVMD/voicemail lifecycle, and media availability.
- CSV export uses the active filters and is rejected above `CALL_HISTORY_EXPORT_MAX_ROWS` (50,000 by default).
- Successful mutating admin requests are recorded in the administrative audit log. Use actor/method/date filters when investigating; request bodies/secrets are intentionally not stored.

## Retention

- Defaults are seven days for terminal call logs and 30 days for call-recording files.
- Automatic retention runs at API startup and daily by default. Multiple API instances are serialized with a PostgreSQL advisory lock.
- Use `POST /admin/retention/run` with `{"dryRun":true}` before a policy change or investigation.
- A call with a recording is retained until the recording is eligible. If unlink fails for a reason other than an already-missing file, metadata and the call remain for retry; investigate the retention failure metric/log.
- Do not assume retention covers audit/legal-hold requirements. Those need an approved external policy.

## Operations

- Review Grafana/Alertmanager, API/DB/ESL/trunk readiness, stuck calls, recording/voicemail errors, retention status, backup freshness, disk, and restarts.
- Confirm that an authenticated backup reached the off-host destination. A local `.enc` file alone is not disaster-recovery acceptance.
- Follow the runbooks for deploy/rollback, backup/restore, incidents, and captures; preserve call ID, both leg UUIDs, UTC time, and deployed SHA.
- Do not claim voicemail success from local playback alone. Verify the far-end mailbox when that is the user-visible requirement.
- Firewall/host-port changes are outside this implementation scope; escalate exposure questions to the named deployment owner.
