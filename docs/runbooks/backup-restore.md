# Backup And Restore Runbook

## What The Backup Contains

`scripts/backup.sh` captures:

- a PostgreSQL custom-format dump;
- the configured voicemail/call recordings directory;
- UTC creation time, source Git commit, database name, and source recordings path.

The bundle is written as an authenticated `ODBACKUP2` envelope by `scripts/backup-envelope.mjs`: AES-256-GCM with a scrypt-derived key, random 16-byte salt, random 12-byte IV, authenticated header, and 16-byte authentication tag. A wrong passphrase, truncated file, or modified ciphertext fails authentication before restore.

The passphrase must contain at least 32 characters and be stored outside the host in the client's secret manager. Losing both host and passphrase makes the archive unusable; keeping the only passphrase on the host defeats disaster recovery.

## Configure

Required/typical `.env` values:

```dotenv
BACKUP_ENCRYPTION_PASSPHRASE=<independent high-entropy secret of at least 32 characters>
BACKUP_DIR=./backups
BACKUP_RETENTION_DAYS=30
BACKUP_QUIESCE_SERVICES=true
BACKUP_S3_URI=s3://approved-bucket/prefix
BACKUP_CRON_SCHEDULE="37 2 * * *"
ALLOW_LOCAL_ONLY_BACKUPS=false
```

When `BACKUP_S3_URI` is set, `backup.sh` uploads the authenticated envelope with the AWS CLI. The bucket should enforce least-privilege write credentials, encryption, versioning/object lock where required, access logging, and lifecycle rules.

Production preflight refuses a missing off-host URI unless `ALLOW_LOCAL_ONLY_BACKUPS=true` explicitly records the accepted local-only risk. That exception is not disaster-recovery acceptance.

Install the daily cron job:

```bash
./scripts/install-backup-cron.sh
```

The installer reads `BACKUP_CRON_SCHEDULE` from `ENV_FILE` (default `.env`), requires a single five-field expression, asks `crontab` to validate/install the resulting file atomically, and preserves that `ENV_FILE` path in the cron command.

## Run And Verify

Create a backup:

```bash
./scripts/backup.sh
```

The script refuses to run while a call/background voicemail is active. With the production default `BACKUP_QUIESCE_SERVICES=true`, it briefly pauses the running API and FreeSWITCH containers while `pg_dump` and the recordings archive are captured, then resumes them before encryption and verification. This prevents application/media writes from splitting the database and filesystem snapshot. `BACKUP_QUIESCE_SERVICES=false` requires the explicit `ALLOW_NON_QUIESCED_BACKUP=true` break-glass acknowledgement and is not an accepted recovery point.

The local file is mode `0600`. Before any S3 upload or success-metric publication, `backup.sh` calls `verify-backup.sh` to authenticate/decrypt the envelope, validate both archives, and inspect the PostgreSQL restore list. Only a verified local archive is uploaded and allowed to update `monitoring/textfile/outbound_dialer_backup.prom`; alerts treat a missing or stale marker as a problem.

Select and verify an archive:

```bash
latest_backup="$(find backups -maxdepth 1 -name 'outbound-dialer-*.tar.gz.enc' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
./scripts/verify-backup.sh "${latest_backup}"
```

Verification must print `Backup verification passed`. It authenticates/decrypts the `ODBACKUP2` envelope, validates the bundle/recordings tar archives, starts PostgreSQL if needed, and runs `pg_restore --list` on the database dump. It does not modify the target database.

Also verify the object exists in the off-host destination and record its object version/checksum/timestamp. Local verification alone does not prove off-host delivery.

## Restore Preconditions

Use an isolated host for drills. For a real recovery, establish incident ownership before proceeding.

1. Check out the matching release with a clean working tree. A newer release requires recorded compatibility review and explicit `ALLOW_COMPATIBLE_RESTORE_VERSION=true` because both the checked-out controller scripts and the selected runtime/backup SHA are checked.
2. Place the archive on the isolated/recovery host through an approved secure channel.
3. Load the correct passphrase from the external secret manager.
4. Configure `.env` for the target, including database, domains, and non-production provider isolation for a drill.
5. Confirm sufficient disk space for the decrypted bundle plus the pre-restore recordings snapshot.
6. Run `scripts/verify-backup.sh` first.
7. Record pre-restore database/file counts and the target's current recordings path.
8. If `logs/deployment-state.env` exists, require `DEPLOYMENT_STATUS=stable`; resolve an interrupted deploy/rollback/restore before starting another restore.

## Guarded Restore

```bash
export RESTORE_CONFIRM="restore-${POSTGRES_DB}"
./scripts/restore.sh /secure/path/outbound-dialer-YYYYMMDDTHHMMSSZ.tar.gz.enc
```

The script:

1. authenticates/decrypts the envelope, validates the recordings archive, and compares source/runtime SHA metadata;
2. resolves the release version from `APP_VERSION`, stable deployment state, or the checked-out Git SHA; requires a clean controller checkout; builds missing release images only when that checkout exactly matches the selected SHA; renders monitoring configuration; and validates every monitoring config with its runtime binary;
3. atomically records `DEPLOYMENT_STATUS=pending_restore` before stopping or changing runtime services;
4. stops API and FreeSWITCH so application writes/calls cannot race restore;
5. starts PostgreSQL;
6. runs `pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction`, then creates/rotates the dedicated read-only `outbound_dialer_exporter` monitoring role;
7. when `RESTORE_RECORDINGS` is not `false`, copies the current recordings directory to a timestamped `.pre-restore-*` snapshot, clears current content except `.gitkeep`, and extracts the archive;
8. starts the full stack with health waits, bootstraps or refreshes TLS, and runs the published web smoke test;
9. reinstalls certificate-renewal and backup cron jobs using the selected `ENV_FILE`, then promotes the restored SHA to a stable deployment state. An interrupted/failed restore retains its pending/failed target for explicit recovery.

The PostgreSQL change is transactional: a database restore error rolls back that database transaction. Recordings replacement is filesystem work and is not part of the PostgreSQL transaction; the pre-restore snapshot is the recovery point. Keep it until formal acceptance.

Set `RESTORE_RECORDINGS=false` only for an intentional database-only recovery and record the resulting database/filesystem consistency decision.

## Legacy Archive Exception

`verify-backup.sh` accepts authenticated `ODBACKUP2` archives only. `restore.sh` rejects legacy unauthenticated AES-256-CBC/PBKDF2 archives by default.

For one specifically trusted pre-upgrade archive only:

```bash
export ALLOW_LEGACY_UNAUTHENTICATED_BACKUP=true
export RESTORE_CONFIRM="restore-${POSTGRES_DB}"
./scripts/restore.sh /secure/path/trusted-legacy-backup.tar.gz.enc
```

Because the legacy format cannot prove integrity, validate provenance/checksums through an independent trusted source and document the exception. Never use the flag to bypass an authentication failure on an expected `ODBACKUP2` archive.

## Post-Restore Acceptance

- [ ] Smoke test completed and `/api/health/ready` is healthy.
- [ ] Users/auth, campaign/contact/import, suppression, call, call-event, audit, and media-ticket table counts are plausible.
- [ ] Voicemail assets preview and call recordings stream/seek where expected.
- [ ] The restored recordings path and permissions match the runtime container mapping.
- [ ] `logs/deployment-state.env` reports `DEPLOYMENT_STATUS=stable` with the restored SHA, and both backup/certificate cron jobs reference the intended `ENV_FILE`.
- [ ] WSS registration works in the isolated target.
- [ ] A controlled call/voicemail test passes only when provider use is explicitly authorized for the drill.
- [ ] RPO/RTO, archive timestamp/version, duration, operator, restored SHA, row/file counts, and manual actions are recorded.
- [ ] The pre-restore recordings snapshot is retained until sign-off, then disposed of under policy.

No backup/restore capability is production-accepted until an off-host archive passes this clean-host drill within the approved RPO/RTO.
