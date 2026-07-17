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

The installer reads `BACKUP_CRON_SCHEDULE` from `ENV_FILE` (default `.env`), requires a single five-field expression, asks `crontab` to validate/install the resulting file atomically, and preserves that `ENV_FILE` path in the cron command. The installed command also records an explicit `PATH` containing the resolved Node.js, Docker, `flock`, and, when `BACKUP_S3_URI` is set, AWS CLI directories. Missing or non-absolute executables fail installation, so cron does not depend on interactive shell initialization, NVM startup files, or a user-local AWS path being present by accident.

## Run And Verify

Create a backup:

```bash
./scripts/backup.sh
```

The script refuses to run while a call/background voicemail is active. It also takes the same non-blocking host-operation `flock` used by deploy, restore, rollback, and certificate maintenance, so these workflows cannot overlap. Nested backup verification inherits that lock. With the production default `BACKUP_QUIESCE_SERVICES=true`, it briefly pauses the running API and FreeSWITCH containers while `pg_dump` and the recordings archive are captured, then resumes them before encryption and verification. A failed resume is retried during cleanup and fails the backup before encryption, upload, success metrics, or success output; remaining paused services require immediate operator recovery. This prevents application/media writes from splitting the database and filesystem snapshot. `BACKUP_QUIESCE_SERVICES=false` requires the explicit `ALLOW_NON_QUIESCED_BACKUP=true` break-glass acknowledgement and is not an accepted recovery point.

The local file is mode `0600`. Before any S3 upload or success-metric publication, `backup.sh` calls `verify-backup.sh` to authenticate/decrypt the envelope, validate both archives, and inspect the PostgreSQL restore list. Only a verified local archive is uploaded and allowed to update `monitoring/textfile/outbound_dialer_backup.prom`; alerts treat a missing or stale marker as a problem.

Select and verify an archive:

```bash
latest_backup="$(find backups -maxdepth 1 -name 'outbound-dialer-*.tar.gz.enc' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
./scripts/verify-backup.sh "${latest_backup}"
```

Verification must print `Backup verification passed`. It authenticates/decrypts the `ODBACKUP2` envelope, validates the bundle/recordings tar archives, starts PostgreSQL with a bounded Compose health wait if needed, and runs `pg_restore --list` on the database dump. It does not modify the target database.

Also verify the object exists in the off-host destination and record its object version/checksum/timestamp. Local verification alone does not prove off-host delivery.

## Restore Preconditions

Use an isolated host for drills. For a real recovery, establish incident ownership before proceeding.

1. Check out the matching release with a clean working tree. A newer release requires recorded compatibility review and explicit `ALLOW_COMPATIBLE_RESTORE_VERSION=true` because both the checked-out controller scripts and the selected runtime/backup SHA are checked.
2. Place the archive on the isolated/recovery host through an approved secure channel.
3. Load the correct passphrase from the external secret manager.
4. Configure `.env` for the target, including database, domains, and non-production provider isolation for a drill. Current authenticated archives must identify the same `postgres_database` as the target `POSTGRES_DB`.
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

1. authenticates/decrypts the envelope, validates the recordings archive, compares source/runtime SHA metadata, and requires authenticated `postgres_database` metadata to match the restore target before any destructive work;
2. resolves the release version from `APP_VERSION`, stable deployment state, or the checked-out Git SHA; requires a clean controller checkout; builds missing release images only when that checkout exactly matches the selected SHA; renders monitoring configuration; and validates every monitoring config with its runtime binary;
3. atomically records `DEPLOYMENT_STATUS=pending_restore` before stopping or changing runtime services;
4. stops API and FreeSWITCH so application writes/calls cannot race restore;
5. when `RESTORE_RECORDINGS` is not `false`, extracts media into same-filesystem staging and finishes a timestamped current-recordings snapshot before deleting the database;
6. starts PostgreSQL with a health wait, verifies `pg_isready`, validates `pg_restore --list`, refuses PostgreSQL system databases, force-disconnects and drops the selected application database, recreates it with the configured owner, then runs `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction` into that empty database and creates/rotates the dedicated read-only `outbound_dialer_exporter` monitoring role;
7. activates the already staged recordings with same-filesystem renames only after the database restore succeeds, restoring the previous directory if activation itself fails;
8. starts the full stack with health waits, bootstraps or refreshes TLS, verifies every in-scope non-firewall mandatory Compose service is running and every configured container health check is healthy, and runs the published readiness smoke test;
9. reinstalls certificate-renewal and backup cron jobs using the selected `ENV_FILE`, then promotes the restored SHA to a stable deployment state. An interrupted/failed restore retains its pending/failed target for explicit recovery.

The old application database is deliberately removed before restore so objects omitted from the archive cannot survive. The custom-format dump is validated first, and `--single-transaction` prevents a failed `pg_restore` from leaving a partially populated replacement database; after a restore failure the replacement can be empty and must not be promoted. Recordings replacement is filesystem work and is not part of the PostgreSQL transaction, but extraction and snapshot creation now fail before database deletion, and activation uses prepared same-filesystem directories with rollback. The `.pre-restore-*` snapshot remains the recovery point; keep it until formal acceptance.

Set `RESTORE_RECORDINGS=false` only for an intentional database-only recovery and record the resulting database/filesystem consistency decision.

## Legacy Archive Exception

`verify-backup.sh` accepts authenticated `ODBACKUP2` archives only. `restore.sh` rejects legacy unauthenticated AES-256-CBC/PBKDF2 archives by default.

For one specifically trusted pre-upgrade archive only:

```bash
export ALLOW_LEGACY_UNAUTHENTICATED_BACKUP=true
export ALLOW_LEGACY_RESTORE_WITHOUT_DATABASE_MATCH=true
export RESTORE_CONFIRM="restore-${POSTGRES_DB}"
./scripts/restore.sh /secure/path/trusted-legacy-backup.tar.gz.enc
```

The first bypass accepts the legacy format's missing integrity proof. The second acknowledges that its `postgres_database` identity is unauthenticated even when a metadata file is present. Independently validate the source database, intended target, provenance, checksum, custody, and contents, and document both exceptions. Never use these flags to bypass an authentication failure on an expected `ODBACKUP2` archive.

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
