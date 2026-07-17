# Deployment And Rollback Runbook

## Purpose

Deploy one reviewed Git commit, reject unsafe configuration, avoid interrupting active calls, take a recoverable backup, run forward-compatible migrations once, wait for health, smoke-test the public path, and retain the previous application images for rollback.

This runbook does not configure or change the host firewall or host-published ports. That review is a separate deployment-owner responsibility and must be complete before production acceptance.

## Prerequisites

- Docker Engine/Compose plugin, Node.js 22, npm, curl, OpenSSL, Git, cron, and sufficient disk for a backup plus image build. The AWS CLI is required when `BACKUP_S3_URI` is configured.
- Production `.env` at repository root. The deploy script sets its mode to `0600` before preflight.
- The environment has been reviewed against [Environment configuration](../environment-configuration.md). In particular, public/private addresses and non-overlapping RTP/TURN ranges must describe the target host rather than the example values.
- Non-placeholder `JWT_SECRET`, `SIP_SECRET_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `POSTGRES_EXPORTER_PASSWORD`, `FREESWITCH_ESL_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, and `BACKUP_ENCRYPTION_PASSPHRASE` (at least 32 characters where preflight requires it). The exporter password is independent from the application owner and is applied to a dedicated `outbound_dialer_exporter` role with `pg_monitor`, read-only transactions, and no application-schema privileges.
- Immutable `FREESWITCH_BASE_IMAGE` `@sha256` digest, valid dialer/Grafana domains, and TLS email.
- Use literal matching `FREESWITCH_EXTERNAL_SIP_IP`/`FREESWITCH_EXTERNAL_RTP_IP` values. Set `TURN_RELAY_IP` to the address actually assigned to the Coturn host interface: the instance private IPv4 for AWS/NAT, or the same public IPv4 on a directly addressed server. See the [networking runbook](aws-networking.md).
- A strong `TURN_SHARED_SECRET`, pinned `COTURN_IMAGE`, and `TURN_URLS` using the primary `LETSENCRYPT_DOMAIN`. The API issues short-lived credentials; never publish the shared secret as a frontend build variable.
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

The script first takes a non-blocking host-operation `flock` shared with backup, restore, rollback, certificate reconciliation, and both cron installers. Nested operations inherit the descriptor; a second independent operation fails closed instead of racing service or database changes.

The script performs these steps:

1. optionally runs a fast-forward-only pull when `DEPLOY_PULL=true`, then re-executes the pulled deploy script;
2. restricts `.env` permissions to `0600`, then validates a clean working tree, required tools/secrets, SIP trunk and SIP-secret gates, immutable FreeSWITCH image digest, alert/backup routing, and the Compose model;
3. derives a 12-character Git SHA version and reads the previous stable deployment state;
4. installs exact lockfile dependencies with `npm ci`, then runs the complete `npm run quality` gate unless explicitly skipped;
5. reads the local API active-call metric and refuses a live deployment by default;
6. creates and self-verifies an authenticated database/recordings backup unless explicitly skipped;
7. pulls external images, builds API/FreeSWITCH/packet-capture/web/proxy with the SHA tag, renders monitoring configuration, and validates Prometheus, Alertmanager, Blackbox Exporter, Loki, and Alloy configuration with their pinned runtime binaries;
8. atomically records `PENDING_VERSION` before changing runtime services or running migrations;
9. starts PostgreSQL/FreeSWITCH, runs migrations once with the new API image, creates/rotates the least-privilege PostgreSQL exporter role, then starts the stack with health waits;
10. ensures/renews certificates, installs deterministic certificate/backup cron jobs, verifies every in-scope non-firewall mandatory Compose service is running and every configured health check is healthy, and runs the public web plus `/api/health/ready` smoke test;
11. promotes the pending SHA to `CURRENT_VERSION` with `DEPLOYMENT_STATUS=stable`. A failure retains `failed_deploy` plus the unconfirmed target instead of claiming the old state matches runtime.

`SKIP_DEPLOY_CHECKS`, `SKIP_PRE_DEPLOY_BACKUP`, `ALLOW_ACTIVE_CALL_DEPLOY`, `ALLOW_UNVERIFIED_ACTIVE_CALL_STATE`, `ALLOW_UNCONFIGURED_SIP_TRUNK`, `ALLOW_NO_ALERT_RECEIVER`, and `ALLOW_LOCAL_ONLY_BACKUPS` are break-glass/risk-acceptance controls. `SKIP_DEPLOY_CHECKS=true` skips `npm run quality`, but dependency installation still runs. Do not use these controls in an ordinary release; record owner, reason, time, and follow-up whenever one is used.

`scripts/deploy.sh` uses repository-root `.env` by default. To use another protected file, pass `ENV_FILE=/absolute/path/to/file`; the same path is propagated to preflight, backup, Compose, certificate, and cron-install workflows. Set `COMPOSE_PROJECT_NAME` explicitly if the stack is not deployed under the default `docker` project name, because Alloy uses it to exclude containers from unrelated Compose projects.

## GitHub Main-Branch Deployment

Pushes to `main` deploy to the client production host only after both GitHub Actions quality and browser jobs pass and the repository variable `CLIENT_DEPLOY_ENABLED` is exactly `true`. The `deploy-client` job connects over SSH and asks the persistent `/opt/outbound-dialer` checkout to deploy the exact `${{ github.sha }}` through `scripts/deploy-commit.sh`.

The target host keeps its production `.env` at `/opt/outbound-dialer/.env` with mode `0600`; no application or provider secrets are copied into GitHub. The wrapper takes a non-blocking deployment lock, refuses a dirty checkout, fetches `origin/main`, verifies the requested full SHA belongs to that branch, checks it out detached, loads Node.js 22 through `$HOME/.nvm/nvm.sh` when a suitable system runtime is not already in `PATH`, and delegates all release gates to `scripts/deploy.sh`. Set `DEPLOY_NODE_VERSION` only when the target intentionally uses a different installed NVM version compatible with the repository's Node.js requirement.

Create a GitHub Environment named `client-production` with these secrets:

- `CLIENT_DEPLOY_HOST`: client server hostname or IP;
- `CLIENT_DEPLOY_PORT`: SSH port, normally `22`;
- `CLIENT_DEPLOY_USER`: dedicated deployment account;
- `CLIENT_DEPLOY_SSH_PRIVATE_KEY`: private key used only by GitHub Actions to reach the deployment account;
- `CLIENT_DEPLOY_SSH_KNOWN_HOSTS`: pinned `known_hosts` line for the exact hostname/IP and port used above.

The host field in `CLIENT_DEPLOY_SSH_KNOWN_HOSTS` must exactly match `CLIENT_DEPLOY_HOST`. For port `22`, use `<host> ssh-ed25519 <public-key>`; for a non-standard port, use `[<host>]:<port> ssh-ed25519 <public-key>`. Obtain the public key or fingerprint through a trusted client-server console and verify it before saving the secret. Do not disable `StrictHostKeyChecking` or replace the pinned entry with an unverified runtime scan.

The client checkout separately needs read-only GitHub access, preferably through a repository deploy key, because the server runs `git fetch`. The deployment account needs permission to run Docker and the host commands required by preflight. Keep `main` protected against force pushes so an approved deployment commit remains an ancestor of `origin/main`.

Leave `CLIENT_DEPLOY_ENABLED` absent or set to `false` during bootstrap. After this workflow commit has landed on `main`, manually update `/opt/outbound-dialer` once so `scripts/deploy-commit.sh` exists, complete the target `.env` and deployment acceptance checks, add the environment secrets, and only then set the repository variable to `true`. The next push to `main` will be the first automatic deployment.

GitHub job concurrency and the shared host `flock` prevent a release from overlapping another deploy, backup, restore, rollback, or certificate operation. A deploy rejected because calls are active or because another operation is running remains failed and must be rerun later; the workflow does not enable any break-glass override or perform a blind automatic rollback.

Migration `019_freeswitch_event_idempotency_index.sql` is explicitly non-transactional and idempotent so PostgreSQL can build its partial unique index with `CREATE INDEX CONCURRENTLY`. Historical `call_events` rows remain unchanged and retain a null replay key; the first post-upgrade observation of an old event establishes the key for subsequent retries. This avoids a blocking historical rewrite/delete during API startup.

## Certificate Renewal Safety

The daily renewal job runs with the deterministic tool `PATH` captured by its installer and takes the shared host-operation lock. The backup installer records the actual Node.js, Docker, `flock`, and, when configured, AWS CLI directories; missing or non-absolute executable paths fail installation. Certbot may update certificate files, but proxy reload and Coturn recreation happen only when the current certificate fingerprint differs from `logs/applied-certificate.sha256`. An unchanged certificate produces no runtime restart.

Before reading active-call state, the certificate workflow closes the durable `ops.call_start_paused` gate in PostgreSQL. Call creation takes a shared lock on that same row, so the maintenance update waits for in-flight starts and new starts fail with a temporary maintenance message until the gate is reopened. This removes the check/start race without restarting the API.

If calls are active after a renewal, applying the new certificate is deferred, the gate is reopened, and the old fingerprint marker remains in place so a later run retries. If active-call state cannot be read, the job fails closed. A changed marker is written only after `nginx -t`, proxy reload, Coturn recreation/running-state verification, and verification that the proxy actually serves the new SHA-256 certificate fingerprint. Failure reopens the gate but leaves the previous marker for retry; failure to reopen the gate is a hard operator incident. A later unchanged-certificate run also reopens the gate after verifying the served fingerprint, which repairs a prior transient reopen failure. `ALLOW_ACTIVE_CALL_CERTIFICATE_APPLY=true` and `ALLOW_UNVERIFIED_CERTIFICATE_APPLY=true` are disruptive break-glass controls and require an explicit maintenance owner and impact record.

## Runtime Containment

All in-scope non-firewall Compose services use bounded local JSON-file log rotation and PID limits. The public proxy runs with a read-only root filesystem, an explicit set of required capabilities, no-new-privileges, read-only certificate volumes, and small writable tmpfs mounts for generated nginx configuration, fallback certificates, cache, PID, and temporary files. Prometheus, Alertmanager, and Grafana have readiness health checks in addition to the application, proxy, PostgreSQL, FreeSWITCH, and packet-capture checks. CI also starts the proxy with the same containment flags, without publishing host ports, and requires its configuration and HTTPS health path to succeed.

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

For stepped Agent Desk capacity, soak, and the separately approved live-call phase, follow
[load-testing.md](load-testing.md). Do not use read-only HTTP load as evidence of SIP/RTP capacity.
