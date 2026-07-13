# Deployment And Rollback Runbook

## Purpose

Deploy one reviewed Git commit, reject unsafe configuration, avoid interrupting active calls, take a recoverable backup, run forward-compatible migrations once, wait for health, smoke-test the public path, and retain the previous application images for rollback.

This runbook does not configure or change the host firewall or host-published ports. That review is a separate deployment-owner responsibility and must be complete before production acceptance.

## Prerequisites

- Docker Engine/Compose plugin, Node.js 22, npm, curl, OpenSSL, Git, cron, and sufficient disk for a backup plus image build. The AWS CLI is required when `BACKUP_S3_URI` is configured.
- Production `.env` at repository root with mode `0600`.
- Non-placeholder `JWT_SECRET`, `SIP_SECRET_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `POSTGRES_EXPORTER_PASSWORD`, `FREESWITCH_ESL_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, and `BACKUP_ENCRYPTION_PASSPHRASE` (at least 32 characters where preflight requires it). The exporter password is independent from the application owner and is applied to a dedicated `outbound_dialer_exporter` role with `pg_monitor`, read-only transactions, and no application-schema privileges.
- Immutable `FREESWITCH_BASE_IMAGE` `@sha256` digest, valid dialer/Grafana domains, and TLS email.
- For an HTTPS FreeSWITCH WSS upstream, certificate verification is on by default. Set `FREESWITCH_WS_UPSTREAM_TLS_SERVER_NAME` to the name on the upstream certificate; `ALLOW_UNVERIFIED_FREESWITCH_WS_UPSTREAM=true` is break-glass only for a separately approved private/self-signed endpoint.
- A real Alertmanager receiver, or an explicitly documented `ALLOW_NO_ALERT_RECEIVER=true` exception.
- `BACKUP_S3_URI`, or an explicitly documented `ALLOW_LOCAL_ONLY_BACKUPS=true` exception.
- Tested/approved provider settings for a production release. Production preflight requires the mode-specific SIP trunk tuple; `ALLOW_UNCONFIGURED_SIP_TRUNK=true` is only for an explicitly approved deployment where outbound customer calls are unavailable.
- No active calls. Deployment refuses a non-zero active-call metric unless break-glass `ALLOW_ACTIVE_CALL_DEPLOY=true` is explicitly set.

Run non-mutating gates first:

```bash
./scripts/preflight.sh
npm ci
npm run quality
```

Do not proceed if any gate fails.

## Normal Deploy

Deploy the checked-out commit:

```bash
./scripts/deploy.sh
```

The script performs these steps:

1. optionally runs a fast-forward-only pull when `DEPLOY_PULL=true`, then re-executes the pulled deploy script;
2. validates a clean working tree, `.env` permissions, required tools/secrets, SIP trunk and SIP-secret gates, immutable FreeSWITCH image digest, alert/backup routing, and the Compose model;
3. derives a 12-character Git SHA version and reads the previous stable deployment state;
4. unless explicitly skipped, runs `npm ci` and the complete `npm run quality` gate;
5. reads the local API active-call metric and refuses a live deployment by default;
6. creates and self-verifies an authenticated database/recordings backup unless explicitly skipped;
7. pulls external images, builds API/FreeSWITCH/web/proxy with the SHA tag, renders monitoring configuration, and validates Prometheus, Alertmanager, Blackbox Exporter, Loki, and Alloy configuration with their pinned runtime binaries;
8. atomically records `PENDING_VERSION` before changing runtime services or running migrations;
9. starts PostgreSQL/FreeSWITCH, runs migrations once with the new API image, creates/rotates the least-privilege PostgreSQL exporter role, then starts the stack with health waits;
10. ensures/renews certificates, installs certificate/backup cron jobs, and runs the web/API smoke test;
11. promotes the pending SHA to `CURRENT_VERSION` with `DEPLOYMENT_STATUS=stable`. A failure retains `failed_deploy` plus the unconfirmed target instead of claiming the old state matches runtime.

`SKIP_DEPLOY_CHECKS`, `SKIP_PRE_DEPLOY_BACKUP`, `ALLOW_ACTIVE_CALL_DEPLOY`, `ALLOW_UNVERIFIED_ACTIVE_CALL_STATE`, `ALLOW_UNCONFIGURED_SIP_TRUNK`, `ALLOW_NO_ALERT_RECEIVER`, and `ALLOW_LOCAL_ONLY_BACKUPS` are break-glass/risk-acceptance controls. Do not use them in an ordinary release; record owner, reason, time, and follow-up whenever one is used.

## Two-Stage SIP Credential Encryption Rollout

SIP passwords historically use `v1`, whose key is derived from `JWT_SECRET`. Current code reads both `v1` and `v2`; `v2` uses the independent `SIP_SECRET_ENCRYPTION_KEY`. Enabling `v2` writes also migrates existing `v1` rows transactionally at API startup. A pre-dual-read image cannot decrypt `v2`, so this change must span two deployments.

### Stage 1 — Deploy Dual Read, Keep `v1` Writes

1. Generate/store a strong independent `SIP_SECRET_ENCRYPTION_KEY` without changing `JWT_SECRET`.
2. Configure:

```dotenv
SIP_SECRET_WRITE_VERSION=v1
SIP_SECRET_V2_ROLLBACK_SAFE=false
```

3. Deploy the release containing dual-read support.
4. Verify login, user provisioning, existing agent provisioning, WSS registration, and a controlled call.
5. Confirm `logs/deployment-state.env` retains an older rollback image and record this deployed SHA as the first dual-read target.

Stage 1 remains rollback-compatible with the older `v1` image because all new/rewritten SIP secrets still use `v1`.

### Stage 2 — Enable `v2` Only With A Dual-Read Rollback Target

Do this on a later release after stage 1 is accepted and its SHA-tagged images are still present.

1. Confirm `PREVIOUS_VERSION` is the accepted dual-read stage-1 image, not a pre-dual-read release.
2. Keep the same `JWT_SECRET` until all `v1` rows have migrated. Keep the same `SIP_SECRET_ENCRYPTION_KEY` permanently unless a separate key-rotation migration is implemented.
3. Configure:

```dotenv
SIP_SECRET_WRITE_VERSION=v2
SIP_SECRET_V2_ROLLBACK_SAFE=true
```

4. Run preflight/deploy. The safety flag is an operator assertion; preflight cannot prove the previous image is compatible.
5. Verify startup did not report a migration failure and record the migrated-count log when non-zero.
6. Verify no `v1` values remain:

```bash
docker compose --env-file .env -f infra/docker/docker-compose.yml exec -T postgres \
  sh -lc 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command="select left(sip_password_encrypted, 2) as version, count(*) from agents group by 1 order by 1;"'
```

7. Repeat user provisioning, WSS registration, and controlled-call acceptance.

After stage 2, rollback is allowed only to a dual-read image. Never roll back to a pre-dual-read/v1-only image. Rotate `JWT_SECRET` separately only after the database has no `v1` rows and the rollback target reads `v2` with the same independent key.

## Application Rollback

Rollback reuses the previous SHA-tagged API/web/proxy/FreeSWITCH images and does not build or reverse migrations.

```bash
source logs/deployment-state.env
export ROLLBACK_CONFIRM="rollback-${PREVIOUS_VERSION}"
./scripts/rollback.sh "${PREVIOUS_VERSION}"
```

The script first verifies all four target images exist, atomically records a `pending_rollback` target, starts the images with `--no-build --wait`, runs the web smoke test, and promotes the target to `CURRENT_VERSION` while retaining the failed version as `PREVIOUS_VERSION`. It can also recover a `pending_deploy`/`failed_deploy` state by defaulting to the last confirmed `CURRENT_VERSION`. A failed or interrupted rollback remains explicit in the state file. Migrations are forward-only, so every release must follow expand/migrate/contract compatibility with its retained rollback target.

For an interrupted/failed deploy, inspect the state and explicitly confirm recovery to the last confirmed version:

```bash
source logs/deployment-state.env
test "${DEPLOYMENT_STATUS}" = pending_deploy -o "${DEPLOYMENT_STATUS}" = failed_deploy
export ROLLBACK_CONFIRM="rollback-${CURRENT_VERSION}"
./scripts/rollback.sh
```

For `pending_rollback`/`failed_rollback`, the script defaults to retrying `PENDING_VERSION`, but the operator must still inspect runtime/container evidence and set the matching `ROLLBACK_CONFIRM`. A `pending_restore`/`failed_restore` requires the backup/restore incident procedure because database and filesystem state may have changed; `rollback.sh` deliberately refuses to guess.

For a stage-2 SIP-secret deployment, verify that `PREVIOUS_VERSION` is dual-read compatible before running rollback. Do not use database restore for an ordinary application regression; use restore only for verified corruption/data loss under the backup/restore runbook.

If the previous image is missing, check out/redeploy an explicitly compatible last-known-good commit. Do not retag an unknown image.

## Post-Release Evidence

- [ ] `/api/health/live`, `/api/health/ready`, and `/api/health` report the expected API/PostgreSQL/ESL state.
- [ ] Public UI/API and Grafana TLS paths are valid.
- [ ] Browser login/logout and session revocation work without a browser-stored JWT.
- [ ] Credentialed SSE connects/reconnects and UI fallback refresh works.
- [ ] Agent WSS registration and provider trunk readiness are green.
- [ ] One authorized controlled call covers ringback/audio/DTMF/hangup; voicemail/recording are tested when approved.
- [ ] Monitoring has no unexplained critical alerts and a configured receiver receives the release test alert.
- [ ] The pre-deploy backup is authenticated, verified, and present off-host.
- [ ] Retention/backup/certificate cron jobs and metrics are current.
- [ ] `logs/deployment-state.env` has `DEPLOYMENT_STATUS=stable`, the intended current/previous SHA, and empty pending/failed fields.
- [ ] Operator, UTC time, commands, exceptions, evidence, and follow-ups are attached to the release record.

These checks are target-environment evidence. The existence of deploy/rollback scripts is not itself production acceptance.
