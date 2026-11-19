# Inbound Retention and Recovery

The scheduled API task and `POST /admin/retention/run` use the same call, recording
and PCAP retention windows. A call must be terminal and its media and work must
be drained. Held slots, unreleased reservations, open offers or transfers,
unsettled connection attempts, live legs, unresolved operations, unacknowledged
command receipts and incomplete ingress checkpoints keep the call and its files.
Fix or reconcile the underlying work before retrying retention.

Retention applies the call window to the end time or the creation time when a
legacy row lacks an end time. A resolved operation also keeps its replay identity
for the full call retention window after resolution. An auto-next link stays
while its source is still retained by age, the intent is open, or its started
call is still active. A recording or PCAP with a longer window also keeps its
call. Once drained and expired, replay mutations, exclusions, offers, attempts,
transfers, reservations, fallback/admission rows and acknowledged ingress
checkpoints are removed before deleting the owning call. Participant and event
history stays with the call. Call graph cleanup runs in batches of up to 100
under the same transaction lock used by admission.

## Audio and configuration

- Customer call recordings and PCAP files follow their own retention clocks.
  A missing file clears expired metadata. Other unlink errors preserve the row
  and report a retryable failure. Preview estimates eligible files without
  unlinking them.
- Campaign library assets follow the existing administrator deletion path.
  Active queue assignments, immutable flow versions, published ingress snapshots
  and pending or live call references pin the asset. Unreferenced library audio
  can be deleted explicitly. Preserve historical configuration and published
  snapshots during ordinary cleanup and restore. Changes in storage policy for
  these snapshots require independent proof that FreeSWITCH can no longer use
  them and that no pending receipt references them.

## Ingress storage and faults

- The SQLite volume stores at most `FREESWITCH_INGRESS_JOURNAL_SLOTS` receipts
  (default and maximum 128). SQLite enforces a 2,048-page cap at its default
  4 KiB page size. Allow additional space for the bounded rollback journal,
  snapshots and filesystem overhead. The age-based SQL job never unlinks or
  truncates the volume. SQLite can recycle a slot only after terminal evidence
  has received an acknowledgement for the exact terminal sequence.
- SQL cleanup requires that the evidence is terminal and the PostgreSQL
  acknowledgement checkpoint equals the evidence sequence. Retained SQLite rows
  and stale reconcile batches can still contain the expired receipt. Under the
  admission lock, a missing terminal SQL identity uses an exact read on the
  private journal socket. An acknowledged/recycled receipt is skipped, and an
  unacknowledged receipt is imported with its original identity and timestamp.
- If captures fail, compare `outbound_dialer_ingress_journal_used` against
  `outbound_dialer_ingress_journal_capacity` and check pending receipts and the
  age of the oldest unacknowledged receipt. The private `GET /status` exposes
  aggregate usage, pending count, oldest arrival and journal request failures.
  Check usable disk and volume permissions, PostgreSQL health, import errors
  and the authoritative FreeSWITCH discovery connection. Inspect the retention
  scheduler or API logs when a retention run fails, then retry after correcting
  the cause. A full or inaccessible journal refuses new durable admission.
- Keep the volume mounted through restart or application rollback. Retain the
  SQLite database and rollback sidecar files together if recovery is required.
  Drain new work and imports before any operational change that may affect the
  sidecar. Use the [backup/restore runbook](runbooks/backup-restore.md) to pair
  an archived journal with its PostgreSQL state.

Rollback compatibility and target enablement are verified under I05.
