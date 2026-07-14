# Production Acceptance Checklist

Record evidence URL/path, UTC date, environment, operator, and deployed SHA for every checked item. The first section records repository capabilities only; it is not production/runtime acceptance.

## Repository Implementation Baseline

- [x] Browser auth uses HttpOnly/Strict cookie sessions, Origin checks for cookie mutations, login rate limiting, logout, session revocation, and Bearer compatibility without browser token persistence.
- [x] Agent live state has credentialed SSE, PostgreSQL notifications, reconnect/heartbeat behavior, and HTTP fallback refresh.
- [x] Contact selection is transactionally locked and applies configurable max-attempt/retry-delay defaults before originate.
- [x] Voicemail drop has idempotent claim, separate request/start/agent-release/terminal events, and ESL reconnect reconciliation.
- [x] Voicemail uploads are probed/transcoded to canonical mono 8 kHz PCM WAV and invalid/over-five-minute inputs are rejected.
- [x] Media access uses scoped short-lived hashed tickets and byte-range streaming instead of JWT query parameters.
- [x] Campaign archive/history, user deactivate/reactivate/password/role lifecycle, suppression import/history, call-history filters/export/detail, and admin mutation audit exist.
- [x] Scheduled retention uses advisory locking and preserves call/recording metadata after non-`ENOENT` unlink failures.
- [x] Backup uses an authenticated `ODBACKUP2` AES-256-GCM envelope; restore requires confirmation and uses transactional PostgreSQL restore.
- [x] Deployment uses preflight, quality gates, active-call guard, pre-deploy backup, SHA images, health waits, smoke test, state record, and explicit rollback.
- [x] SIP secret encryption supports a two-stage, dual-read `v1` to independent-key `v2` migration.
- [x] Agent/admin guides, runbooks, known limitations, and this acceptance checklist exist.

## Final Build Evidence

- [ ] The final SHA passes lint, formatting, typecheck, workspace unit/integration tests, and production build.
- [ ] Browser E2E passes against the release deployment.
- [ ] Compose configuration validates with the target `.env`; production preflight passes without ordinary-use break-glass flags.
- [ ] Migration from the production predecessor and startup provisioning complete successfully.
- [ ] Dependency audits and container/image review have no unaccepted release-blocking findings.

## External Decisions

- [ ] Provider mode, routing values, caller ID, codecs/DTMF, allowlisting, limits, and support contact are recorded.
- [ ] Final DNS/NAT/public-IP/WSS/SIP/RTP topology is recorded.
- [ ] Calling windows/timezone, outcome retry rules/attempts, recording consent, DNCR evidence, retention/legal hold, export access, and audit duration are approved.
- [ ] Production, alert, backup, incident, and escalation owners are named.
- [ ] Firewall and host-port exposure are reviewed separately by the deployment owner; this repository pass did not change them.

## Functional Live Calls

- [ ] Agent registers through target production WSS and remains stable through reconnect/browser refresh.
- [ ] Human answer, busy, rejected, no-answer, customer hangup, agent hangup, and provider failure create the approved terminal state/outcome/contact policy.
- [ ] Suppressed campaign/manual numbers never reach originate/trunk and create the expected evidence.
- [ ] Ringback, early media, two-way audio, and DTMF work on representative carrier/IVR destinations.
- [ ] Call recording starts only when enabled, stops cleanly, has valid audio, streams/seeks securely, and follows consent policy.
- [ ] Call history filters, pagination, detail timeline, media playback, and bounded export match live records.

## Voicemail Live Acceptance

- [ ] Canonical WAV/MP3 upload, preview, default selection, deactivation, and malformed/oversized rejection work in the release environment.
- [ ] Repeated/concurrent Drop requests produce one transfer/lifecycle.
- [ ] Playback-start evidence releases only the agent leg; the customer leg remains tracked.
- [ ] The agent can start the next interactive call while the background voicemail job remains visible.
- [ ] Completed, interrupted, failed, customer-hangup, and lost-channel paths produce the expected events/outcomes/contact state.
- [ ] Several representative external mailboxes record the complete message. Local playback logs/events alone are not accepted as proof.

## Reliability And Load

- [ ] API restart, ESL disconnect/reconnect, FreeSWITCH restart, provider rejection, orphaned agent leg, missing customer leg, and lost background job are reconciled correctly.
- [ ] Agreed concurrency/load/soak passes under [the load-testing runbook](runbooks/load-testing.md) without duplicate calls, reordered terminal state, stuck agents/contacts, unbounded event growth, or unacceptable latency/error rate.
- [ ] SSE reconnect/fallback prevents stale operator state during transient API/DB-listener/network failures.
- [ ] Retention dry-run matches expected eligibility; execution removes only eligible calls/files and preserves failed-unlink metadata plus all approved audit/legal-hold data.

## Deployment, Monitoring, And Recovery

- [ ] Zero-active-call deployment succeeds and records the expected SHA/state.
- [ ] Failed/new-code release follows the documented previous-image rollback path without a schema rollback.
- [ ] Stage 1 SIP-secret deployment keeps `v1` writes; stage 2 enables `v2` only after the retained rollback image is proven dual-read compatible.
- [ ] Alertmanager test alerts reach named recipients, and an independent off-host probe detects total host/application outage.
- [ ] A daily authenticated backup is delivered off-host and its freshness alert is green.
- [ ] `verify-backup.sh` authenticates the selected archive.
- [ ] A clean-host restore drill recovers database and recordings within approved RPO/RTO; row/file counts, previews, login, WSS, and controlled call are verified.
- [ ] Restore keeps the pre-restore recordings snapshot until formal drill acceptance.

## Handover

- [ ] Agents and administrators complete training using the guides.
- [ ] Client operators exercise deployment, rollback, backup/restore, incident, and capture runbooks.
- [ ] Known limitations and remaining external decisions have owners and due dates.
- [ ] Evidence package and follow-ups are signed off by product, operations, provider, and compliance owners.
