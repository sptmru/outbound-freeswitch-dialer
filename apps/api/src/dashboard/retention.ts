import { unlink } from "node:fs/promises";
import type pg from "pg";
import type { RetentionRunResponse } from "@outbound-dialer/shared";
import { ADMISSION_LOCK_NAMESPACE } from "../call-admission.js";

export const drainedCallPredicate = `
  calls.state in ('completed', 'failed', 'canceled')
  and not exists (select 1 from agent_call_slots s where s.call_id = calls.id)
  and not exists (select 1 from call_capacity_reservations r where r.call_id = calls.id and r.state <> 'released')
  and not exists (select 1 from call_legs l where l.call_id = calls.id and l.ended_at is null)
  and not exists (select 1 from call_participants p where p.call_id = calls.id and p.origin = 'native' and p.left_at is null)
  and not exists (select 1 from call_supervisor_sessions s where s.call_id = calls.id and s.state in ('active','connecting'))
  and not exists (select 1 from supervisor_leg_evidence l where l.call_id = calls.id and l.ended_at is null)
  and not exists (select 1 from call_operations o where o.call_id = calls.id and o.resolved_at is null)
  and not exists (
    select 1 from call_operations o join call_command_fences f on f.operation_id = o.id
    where o.call_id = calls.id and not exists (
      select 1 from call_command_receipt_acks a where a.operation_id = o.id))
  and not exists (select 1 from call_transfers t where t.call_id = calls.id and t.closed_at is null)
  and not exists (select 1 from call_offers o where o.call_id = calls.id and o.closed_at is null)
  and not exists (select 1 from inbound_connection_attempts a where a.call_id = calls.id and a.settled_at is null)
  and not exists (
    select 1 from inbound_ingress_evidence e where e.call_id = calls.id
    and (e.terminal_at is null or e.acknowledged_sequence <> e.evidence_sequence))
  and (calls.ended_at is not null or not exists (
    select 1 from call_operations o where o.call_id = calls.id
    union all select 1 from call_offers o where o.call_id = calls.id
    union all select 1 from call_transfers t where t.call_id = calls.id))
`;

const expired = `
  coalesce(calls.ended_at, calls.created_at) < now() - ($1::text || ' days')::interval
  and not exists (
    select 1 from call_operations o where o.call_id = calls.id
    and o.resolved_at >= now() - ($1::text || ' days')::interval)
  and not exists (
    select 1 from agent_auto_next_intents i join calls source on source.id = i.source_call_id
    left join calls started on started.id = i.started_call_id
    where (i.source_call_id = calls.id or i.started_call_id = calls.id)
    and (i.closed_at is null or source.ended_at is null
      or source.ended_at >= now() - ($1::text || ' days')::interval
      or (started.id is not null and started.ended_at is null)))
`;

// Remove restrictive dependencies first. Remaining history, participants, media
// statistics and execution metadata cascade from the owning call or operation.
const deleteCallWork = [
  "delete from agent_auto_next_intents where source_call_id = any($1::uuid[]) or started_call_id = any($1::uuid[])",
  "delete from call_offer_accept_mutations where offer_id in (select offer_id from inbound_connection_attempts where call_id = any($1::uuid[]))",
  "delete from inbound_connection_attempts where call_id = any($1::uuid[])",
  "delete from call_offer_mutations where offer_id in (select id from call_offers where call_id = any($1::uuid[]))",
  "delete from call_offer_exclusions where call_id = any($1::uuid[])",
  "delete from call_offers where call_id = any($1::uuid[])",
  "delete from transfer_offer_mutations where transfer_id in (select id from call_transfers where call_id = any($1::uuid[]))",
  "delete from call_transfers where call_id = any($1::uuid[])",
  "delete from call_capacity_reservations where call_id = any($1::uuid[])",
  "delete from call_supervisor_sessions where call_id = any($1::uuid[])",
  "delete from inbound_fallback_runs where call_id = any($1::uuid[])",
  "delete from inbound_queue_admissions where call_id = any($1::uuid[])",
  "delete from inbound_ingress_evidence where call_id = any($1::uuid[])",
  "delete from call_operations where call_id = any($1::uuid[])"
];

export async function runRetention(
  pool: pg.Pool,
  input: {
    dryRun: boolean;
    callRetentionDays: number;
    recordingRetentionDays: number;
    pcapRetentionDays: number;
  },
  options: RetentionOptions = {}
): Promise<RetentionRunResponse> {
  const recordings = await pool.query<{ id: string; call_recording_path: string }>(
    `
      select id, call_recording_path
      from calls
      where call_recording_path is not null
        and coalesce(ended_at, created_at) < now() - ($1::text || ' days')::interval
        and call_recording_status not in ('pending', 'recording', 'finalizing')
        and ${drainedCallPredicate}
    `,
    [input.recordingRetentionDays]
  );
  const pcaps = await pool.query<{ call_id: string; file_path: string }>(
    `
      select call_id, file_path
      from call_pcaps
      join calls on calls.id = call_pcaps.call_id
      where call_pcaps.file_path is not null
        and coalesce(calls.ended_at, calls.created_at) < now() - ($1::text || ' days')::interval
        and call_pcaps.status in ('available', 'failed')
        and ${drainedCallPredicate}
    `,
    [input.pcapRetentionDays]
  );
  if (input.dryRun) {
    const calls = await pool.query<{ count: string }>(
      `
        select count(*) as count
        from calls
        where ${expired} and ${drainedCallPredicate}
          and call_recording_status not in ('pending', 'recording', 'finalizing')
          and (
            call_recording_path is null
            or coalesce(ended_at, created_at) < now() - ($2::text || ' days')::interval
          )
          and not exists (
            select 1 from call_pcaps
            where call_pcaps.call_id = calls.id
              and call_pcaps.file_path is not null
              and (call_pcaps.status not in ('available', 'failed')
                or coalesce(calls.ended_at, calls.created_at) >= now() - ($3::text || ' days')::interval)
          )
      `,
      [input.callRetentionDays, input.recordingRetentionDays, input.pcapRetentionDays]
    );
    return {
      dryRun: true,
      callRetentionDays: input.callRetentionDays,
      recordingRetentionDays: input.recordingRetentionDays,
      pcapRetentionDays: input.pcapRetentionDays,
      calls: Number(calls.rows[0]?.count ?? 0),
      recordingFiles: recordings.rowCount ?? recordings.rows.length,
      pcapFiles: pcaps.rowCount ?? pcaps.rows.length
    };
  }

  const unlinkFile = options.unlinkFile ?? unlink;
  const unlinkedRecordingIds: string[] = [];
  for (const recording of recordings.rows) {
    try {
      await unlinkFile(recording.call_recording_path);
      unlinkedRecordingIds.push(recording.id);
    } catch (error) {
      if (isMissingFileError(error)) {
        // The desired retained state is already true. Clear stale metadata so
        // the call row can continue through normal retention.
        unlinkedRecordingIds.push(recording.id);
      } else {
        options.onUnlinkError?.(error, recording);
      }
    }
  }
  const unlinkedPcapCallIds: string[] = [];
  for (const capture of pcaps.rows) {
    try {
      await unlinkFile(capture.file_path);
      unlinkedPcapCallIds.push(capture.call_id);
    } catch (error) {
      if (isMissingFileError(error)) {
        unlinkedPcapCallIds.push(capture.call_id);
      } else {
        options.onPcapUnlinkError?.(error, capture);
      }
    }
  }

  let deletedCalls = 0;
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (unlinkedRecordingIds.length) {
      await client.query(
        `
          update calls
          set call_recording_path = null,
              call_recording_status = 'expired',
              call_recording_failure_reason = null,
              updated_at = now()
          where id = any($1::uuid[])
            and call_recording_path is not null
            and state in ('completed', 'failed', 'canceled')
        `,
        [unlinkedRecordingIds]
      );
    }
    if (unlinkedPcapCallIds.length) {
      await client.query(
        `
          update call_pcaps
          set file_path = null,
              file_size_bytes = null,
              status = 'expired',
              failure_reason = null,
              updated_at = now()
          where call_id = any($1::uuid[])
            and file_path is not null
            and status in ('available', 'failed')
        `,
        [unlinkedPcapCallIds]
      );
    }
    await client.query("commit");
    deletedCalls = await pruneCalls(client, input.callRetentionDays);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return {
    dryRun: false,
    callRetentionDays: input.callRetentionDays,
    recordingRetentionDays: input.recordingRetentionDays,
    pcapRetentionDays: input.pcapRetentionDays,
    calls: deletedCalls,
    recordingFiles: unlinkedRecordingIds.length,
    pcapFiles: unlinkedPcapCallIds.length
  };
}

async function pruneCalls(client: pg.PoolClient, days: number) {
  let count = 0;
  for (;;) {
    await client.query("begin");
    // Match ingress and native admission lock order before locking call rows.
    await client.query("select pg_advisory_xact_lock($1,0)", [ADMISSION_LOCK_NAMESPACE]);
    const candidates = await client.query<{ id: string }>(
      `
        select id from calls where ${expired} and ${drainedCallPredicate}
          and call_recording_path is null
          and call_recording_status not in ('pending', 'recording', 'finalizing')
          and not exists (
            select 1 from call_pcaps
            where call_pcaps.call_id = calls.id
              and call_pcaps.file_path is not null
          )
        order by coalesce(ended_at, created_at), id
        limit 100 for update skip locked
      `,
      [days]
    );
    const ids = candidates.rows.map(({ id }) => id);
    if (ids.length) {
      for (const statement of deleteCallWork) await client.query(statement, [ids]);
      const deleted = await client.query("delete from calls where id = any($1::uuid[])", [ids]);
      count += deleted.rowCount ?? 0;
    }
    const evidence = await client.query(
      `delete from inbound_ingress_evidence where ingress_id in (
        select ingress_id from inbound_ingress_evidence
        where call_id is null and acknowledged_sequence = evidence_sequence
          and terminal_at < now() - ($1::text || ' days')::interval
        order by terminal_at, ingress_id limit 100 for update skip locked
      )`,
      [days]
    );
    await client.query("commit");
    if (ids.length < 100 && (evidence.rowCount ?? 0) < 100) return count;
  }
}

export type RetentionOptions = {
  unlinkFile?: (path: string) => Promise<void>;
  onUnlinkError?: (error: unknown, recording: { id: string; call_recording_path: string }) => void;
  onPcapUnlinkError?: (error: unknown, capture: { call_id: string; file_path: string }) => void;
};

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
