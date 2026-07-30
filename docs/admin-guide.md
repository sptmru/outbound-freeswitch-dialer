# Administrator Guide

## Live Calls

- Open **Live calls** and wait for **Supervisor phone ready**. This uses a dedicated supervisor identity; it does not activate the Agent Desk phone.
- Select **Listen** on a connected conversation. Every session starts listen-only, and the browser does not request microphone access in this mode.
- Use **Coach agent** only when the operating policy allows it. The browser requests the saved microphone device/profile, and only the agent should hear you.
- Use **Join call** only after reviewing the confirmation that both parties will hear you. The agent sees a visible state banner for all three modes; the customer receives no automatic disclosure prompt from this product.
- Click **Stop monitoring** before leaving the workflow or starting an Agent Desk call. The API also blocks concurrent monitoring/Agent Desk starts across tabs and limits each admin to one active supervisor session.
- Treat FreeSWITCH/API confirmation as technical evidence, not proof of audibility. Before production use, run a controlled call matrix for listen, coach, join, mute/default microphone, permission denial, reconnect, agent/customer hangup, multiple supervisors, and recording playback.
- Access is limited to active admins and start/change/stop actions are audited. Obtain approval for who may monitor, required notices/consent, recording treatment, retention, and periodic audit review before enabling the workflow operationally.

## Analytics

- Open **Analytics** for the operational scorecard. Select Today, 7 days, or 30 days and optionally narrow the view to one campaign. Date boundaries and daily buckets use the IANA timezone reported by the browser and show that timezone next to the source context.
- Read **Answer rate** as calls with `answered_at` divided by attempts. Read **Contact rate** as answered calls excluding detected/dropped voicemail divided by attempts; this is an operational proxy rather than independently reviewed human-contact truth.
- The call funnel, daily trend, campaign performance, agent performance, voicemail lifecycle, AVMD review evidence, media quality, and finalization latency use the selected call period. Data-quality counts and reconciliation drift are current snapshots and carry their own observation timestamps.
- Use attempts together with unique contacts and contact rate. Attempts alone can rise because of retries without improving campaign reach or connection quality.
- Retry efficiency describes repeated contacts that later connected; small denominators can move sharply, so use it with attempted-contact volume.
- Use **Refresh** after an operational change when an immediate reread is required. The analytics page is not a replacement for the near-real-time call controls or Grafana health dashboard.

## Campaigns And Contacts

- Create a campaign in `draft`, review its contact data and policy, then activate it. Use `paused` to stop new calls temporarily and `archived` to preserve closed campaign history.
- Configure manual dialing, call recording, and early-media AVMD per campaign. These controls do not replace legal/provider approval.
- Import comma- or semicolon-separated CSV with the intentionally narrow required `name` and `phone` columns; the delimiter is detected automatically. Review accepted/rejected/duplicate counts and page through every rejected row before activation.
- Search/filter the paginated contact list and verify that completed, suppressed, currently calling, exhausted, or retry-delay contacts are not offered as callable. Opening Contacts follows the campaign selected on Agent Desk.
- Defaults are three committed attempts and a 15-minute retry delay. Change `CONTACT_MAX_ATTEMPTS`/`CONTACT_RETRY_DELAY_SECONDS` only after the operating policy is approved.

## Voicemail Recordings

- Upload one WAV or MP3 from **Recordings**. The API probes and transcodes it to mono 8 kHz signed 16-bit PCM WAV with loudness normalization; malformed/no-audio/over-five-minute input is rejected.
- Preview the canonical file, check duration/size, and keep one appropriate global default.
- Deactivation/removal preserves database references used by historical calls. Do not change the active library during a live voicemail test without recording the context.
- Playback in the browser uses short-lived media tickets. If a long-open player expires, retry playback to obtain a new ticket.

## Users And Sessions

- Create named accounts; never share agent/admin credentials.
- Edit name/email/role, reset passwords, and deactivate/reactivate through the supported UI/API.
- Password reset and deactivation revoke outstanding sessions. Deactivation is refused while the user has an active interactive call or live-call monitoring session and removes agent/supervisor FreeSWITCH registration material while preserving history. Stop monitoring before removing an admin role.
- Do not use physical deletion or direct SQL to offboard users.

## Suppression

- Add/search normalized numbers, import an approved CSV, and keep a meaningful reason/source.
- Manual and campaign dialing are checked before originate.
- Creation/update/import/removal and blocked manual-dial attempts are preserved in `suppression_events`.
- Treat removal as a compliance-sensitive action: confirm the normalized number and retain the required source/evidence outside the current-entry table where policy demands it.

## History And Audit

- Filter call history by search text, campaign, agent, outcome, date, voicemail drop/signal, and recording availability.
- Open call detail for leg UUIDs, state events, commands, hangup causes, AVMD/voicemail lifecycle, and media availability. Technical history shows the latest 100 events and explicitly reports when older events were omitted.
- For an answered call with a playable recording, use **AVMD review** to label what actually answered as Human, Voicemail / machine, or Uncertain. Listen before labeling; the detector result alone is not ground truth. Analytics always shows reviewed-sample coverage next to precision/recall.
- Technical media cards report FreeSWITCH RTP counters captured at hangup separately for the agent and customer legs. Browser WebRTC evidence is shown separately and includes packet loss, concealed samples, maximum jitter/RTT, average playout jitter-buffer delay, ICE candidate path, codecs, and applied microphone DSP. A suspected one-way flag is diagnostic evidence, not confirmation of what either party heard.
- CSV export uses the active filters and is rejected above `CALL_HISTORY_EXPORT_MAX_ROWS` (50,000 by default).
- Successful mutating admin requests are recorded in the administrative audit log. Use actor/method/date filters when investigating; request bodies/secrets are intentionally not stored.

## Retention

- Defaults are seven days for terminal call logs and 30 days for call-recording files.
- Automatic retention runs at API startup and daily by default. Multiple API instances are serialized with a PostgreSQL advisory lock.
- Use `POST /admin/retention/run` with `{"dryRun":true}` before a policy change or investigation.
- A call with a recording is retained until the recording is eligible. If unlink fails for a reason other than an already-missing file, metadata and the call remain for retry; investigate the retention failure metric/log.
- Do not assume retention covers audit/legal-hold requirements. Those need an approved external policy.

## Operations

- In Settings, enable Slack alerts only after the deployment owner configures both `ALERTMANAGER_SLACK_WEBHOOK_URL` and `ALERTMANAGER_SLACK_CHANNEL`. The webhook URL remains secret and is never returned to the browser.
- Review Grafana/Alertmanager, API latency/error rate, DB/ESL/trunk readiness, ESL queue health, registration and active-call drift, media coverage/suspected one-way flags, terminal finalization, stuck calls and voicemail jobs, recording finalization, retention status, backup freshness, TLS, disk, and restarts.
- Confirm that an authenticated backup reached the off-host destination. A local `.enc` file alone is not disaster-recovery acceptance.
- Follow the runbooks for deploy/rollback, backup/restore, incidents, and captures; preserve call ID, both leg UUIDs, UTC time, and deployed SHA.
- Do not claim voicemail success from local playback alone. Verify the far-end mailbox when that is the user-visible requirement.
- Firewall/host-port changes are outside this implementation scope; escalate exposure questions to the named deployment owner.
