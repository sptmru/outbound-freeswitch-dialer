import type pg from "pg";
import { randomUUID } from "node:crypto";
import { withCallAdmission } from "./call-admission.js";
import { isCoordinatedCall, reconcileCoordinatedCallCleanup } from "./call-cleanup.js";
import { enqueueCallCommand, type CallExecutor } from "./call-executor.js";
import { acknowledgeResolvedCommandReceipts, recoverCommandReceipts } from "./command-recovery.js";
import { expireInboundOffers } from "./call-offer-expiry.js";
import { ingressUuid } from "./ingress-journal.js";

/** Supplied by the actual ESL persistence owner, never by an HTTP request.
 * A ticket is invalidated on event arrival, disconnect, overflow or persistence
 * loss. Draining an old queue while disconnected cannot grant absence authority.
 */
export interface RecoveryBarrier {
  waitForIdle(): Promise<void>;
  ticket(): (() => boolean) | null;
}
export class RecoveryObservationChanged extends Error {
  constructor() {
    super("recovery_observation_changed");
  }
}
const requireCurrent = (current: () => boolean, signal: AbortSignal) => {
  if (signal.aborted || !current()) throw new RecoveryObservationChanged();
};
const legIdentity = (rows: pg.QueryResultRow[]) =>
  JSON.stringify(rows.map((r) => [r.id, r.freeswitch_uuid, r.participant_id]));

/** An execution lock alone cannot fence an already sent command. Inspect no
 * absence until every attempted command has durable terminal resolution. An
 * unknown native response is an error, never false. No transaction spans ESL.
 * This path sends NO media commands and never guesses a bridge/playback result.
 */
export async function recoverQuiescentCall(
  pool: pg.Pool,
  executor: Pick<CallExecutor, "inspectCall">,
  callId: string,
  command: (command: string) => Promise<string>,
  current: () => boolean
) {
  const result = await executor.inspectCall(callId, async (db, signal) => {
    requireCurrent(current, signal);
    if (!(await isCoordinatedCall(db, callId))) return "legacy";
    const unresolved = () =>
      db.query(
        `select o.id from call_operations o where o.call_id=$1 and o.resolved_at is null
       and (o.state<>'pending' or exists(select 1 from call_execution_attempts x where x.operation_id=o.id)) limit 1`,
        [callId]
      );
    if ((await unresolved()).rowCount) return "uncertain_sender";
    const legs = (await db.query("select * from call_legs where call_id=$1 order by id limit 33", [callId]))
      .rows;
    if (legs.length > 32) return "leg_bound";
    const customer = legs.find((l) => l.type === "customer");
    if (!customer || !ingressUuid.test(customer.freeswitch_uuid ?? "")) return "missing_customer_identity";
    const absent = new Set<string>();
    for (const leg of legs.filter((l) => !l.ended_at)) {
      requireCurrent(current, signal);
      if (!ingressUuid.test(leg.freeswitch_uuid ?? "")) return "missing_leg_identity";
      const response = (await command(`uuid_exists ${leg.freeswitch_uuid}`)).trim();
      if (response !== "true" && response !== "false")
        throw new Error("Unknown recovery uuid_exists response");
      if (response === "false") absent.add(leg.id);
    }
    requireCurrent(current, signal);
    return withCallAdmission(db, { callIds: [callId] }, async (a) => {
      requireCurrent(current, signal);
      if ((await unresolved()).rowCount) return "uncertain_sender";
      const fresh = (await db.query("select * from call_legs where call_id=$1 order by id", [callId])).rows;
      if (legIdentity(fresh) !== legIdentity(legs)) throw new RecoveryObservationChanged();
      const call = (await db.query("select * from calls where id=$1", [callId])).rows[0];
      // Pending operations can be canceled only when the customer is known gone
      // or already terminal. A missing pending recipient is normal before SIP.
      const closing = call.ended_at || customer.ended_at || absent.has(customer.id);
      if (
        !closing &&
        (
          await db.query("select 1 from call_operations where call_id=$1 and resolved_at is null limit 1", [
            callId
          ])
        ).rowCount
      )
        return "pending_sender";
      if (closing) {
        await db.query(
          `update call_operations set state='canceled',resolved_at=clock_timestamp(),
           resolution_evidence='H01 customer absent/terminal under execution lock; sender never attempted'
           where call_id=$1 and state='pending' and request->>'h01Cleanup' is distinct from 'true'
             and not exists(select 1 from call_execution_attempts x where x.operation_id=call_operations.id)`,
          [callId]
        );
        // Missing terminal events cannot establish a successful conversation,
        // completed flow or voicemail. Preserve manual corrections and all
        // previously persisted terminal outcomes/deadlines.
        await db.query(
          `update calls set state='failed',outcome='failed',ended_at=clock_timestamp(),
           terminal_source='lifecycle_recovery',terminal_event_name='RECOVERY_ABSENT',
           terminal_persisted_at=clock_timestamp(),inbound_end_reason=case when direction='inbound' then 'channel_absent_on_recovery' else inbound_end_reason end,
           queue_exited_at=case when direction='inbound' then coalesce(queue_exited_at,clock_timestamp()) else queue_exited_at end,
           updated_at=clock_timestamp() where id=$1 and ended_at is null and manual_status_locked_at is null`,
          [callId]
        );
        await db.query(
          "update call_offers set state='canceled',reason='call_closed',closed_at=clock_timestamp() where call_id=$1 and state='pending' and kind='inbound'",
          [callId]
        );
      }
      if (closing)
        for (const leg of fresh.filter((l) => !l.ended_at && !absent.has(l.id))) {
          const old = (
            await db.query(
              "select * from call_operations where call_id=$1 and request->>'h01Cleanup'='true' and request->>'legId'=$2 order by created_at desc limit 1",
              [callId, leg.id]
            )
          ).rows[0];
          if (old && (!old.resolved_at || old.state === "succeeded")) continue;
          const attempt = Number(old?.request.cleanupAttempt ?? 0) + 1;
          await enqueueCallCommand(a, {
            id: randomUUID(),
            callId,
            scope: `h01-cleanup:${callId}`,
            key: `${leg.id}:${attempt}`,
            fingerprint: "0".repeat(64),
            kind: "hangup",
            generation: "1",
            commandUuid: randomUUID(),
            targetUuid: leg.freeswitch_uuid,
            request: {
              h01Cleanup: true,
              legId: leg.id,
              participantId: leg.participant_id,
              cleanupAttempt: attempt
            },
            deadline: (await db.query("select clock_timestamp()+interval '30 seconds' as at")).rows[0].at
          });
        }
      for (const leg of fresh.filter((l) => absent.has(l.id) && !l.ended_at)) {
        await db.query("update call_legs set state='ended',ended_at=clock_timestamp() where id=$1", [leg.id]);
        await db.query(
          "update call_participants set left_at=coalesce(left_at,clock_timestamp()),end_reason=coalesce(end_reason,'channel_absent_on_recovery') where id=$1",
          [leg.participant_id]
        );
        await db.query(
          `insert into call_events(call_id,event_type,freeswitch_event_name,agent_leg_uuid,customer_leg_uuid,raw_json)
           values($1,'lifecycle_recovery_absent','RECOVERY_ABSENT',$2,$3,$4)`,
          [
            callId,
            leg.type === "customer" ? null : leg.freeswitch_uuid,
            leg.type === "customer" ? leg.freeswitch_uuid : null,
            {
              legId: leg.id,
              participantId: leg.participant_id,
              evidence: "quiescent senders; execution lock; current ESL persistence ticket; exact UUID absent"
            }
          ]
        );
      }
      await expireInboundOffers(db, [], [callId]);
      await db.query(
        "update call_offers set state='expired',reason='deadline_elapsed',closed_at=clock_timestamp() where call_id=$1 and kind='inbound' and state='pending' and deadline_at<=clock_timestamp()",
        [callId]
      );
      requireCurrent(current, signal);
      return absent.size ? "observed_absence" : "live";
    });
  });
  if (result.status === "inspected" && ["observed_absence", "live"].includes(result.value))
    await reconcileCoordinatedCallCleanup(pool, callId);
  return result;
}

/** Explicit staged dependencies. I05 owns bootstrap/pools/enablement. All media
 * progression stays in the original C03-backed workers with their saved IDs.
 */
export interface LifecycleRecoveryWorkers {
  ingress: { reconcile(): Promise<unknown> };
  connection: { wakeExecutor(id: string): Promise<unknown> };
  transfer: { wakeExecutor(id: string): Promise<unknown> };
  fallback: { tick(callId: string): Promise<unknown> };
  control: { wakeExecutor(id: string): Promise<unknown> };
  cleanup?: { reconcile(callId: string): Promise<unknown> };
}
export function createLifecycleRecovery(
  pool: pg.Pool,
  executor: Pick<CallExecutor, "inspectCall">,
  workers: LifecycleRecoveryWorkers,
  command: (command: string) => Promise<string>
) {
  let cursor: string | null = null;
  let running = false;
  return {
    acknowledgeReceipts: () => acknowledgeResolvedCommandReceipts(pool, executor, command),
    async reconcile(barrier: RecoveryBarrier) {
      if (running) return { status: "coalesced" as const, calls: [] };
      running = true;
      try {
        await barrier.waitForIdle();
        const current = barrier.ticket();
        if (!current || !current()) return { status: "backlog" as const, calls: [] };
        // Includes identities with no first SQL row; D03/D04 retain arrival and
        // journal ACK protocol. No call-row-only recovery can replace this step.
        await workers.ingress.reconcile();
        if (!current()) return { status: "backlog" as const, calls: [] };
        const candidates = (
          await pool.query(
            `select c.id from calls c where ($1::uuid is null or c.id>$1::uuid)
           and (c.direction='inbound' or exists(select 1 from call_operations o where o.call_id=c.id)
             or exists(select 1 from call_participants p where p.call_id=c.id and p.origin='native'))
           and (c.ended_at is null or exists(select 1 from call_legs l where l.call_id=c.id and l.ended_at is null)
             or exists(select 1 from call_operations o where o.call_id=c.id and o.resolved_at is null)
             or exists(select 1 from call_capacity_reservations r where r.call_id=c.id and r.state<>'released')
             or exists(select 1 from agent_call_slots s where s.call_id=c.id and s.state<>'free')
             or exists(select 1 from inbound_connection_attempts x where x.call_id=c.id and x.settled_at is null)
             or exists(select 1 from call_transfers t where t.call_id=c.id and t.closed_at is null)
             or exists(select 1 from call_command_fences f join call_operations o on o.id=f.operation_id where o.call_id=c.id and not exists(select 1 from call_command_receipt_acks a where a.operation_id=o.id)))
           order by c.id limit 8`,
            [cursor]
          )
        ).rows;
        const calls: Array<{ callId: string; result?: unknown; error?: string }> = [];
        for (const row of candidates) {
          if (!current()) break;
          cursor = row.id;
          try {
            await recoverCommandReceipts(pool, executor, row.id, command, current);
            if (!current()) break;
            await recoverQuiescentCall(pool, executor, row.id, command, current);
            const roots = (
              await pool.query(
                `select 'connection' as kind,operation_id::text as id from inbound_connection_attempts where call_id=$1 and settled_at is null
               union all select 'transfer',t.operation_id::text from call_transfers t where t.call_id=$1 and t.operation_id is not null
                 and (t.closed_at is null or exists(select 1 from call_operations o where o.call_id=t.call_id and o.resolved_at is null and (o.id=t.operation_id or o.request->>'transferRootId'=t.operation_id::text))
                   or exists(select 1 from call_capacity_reservations r where r.operation_id=t.operation_id and r.resource_type='transfer_overlap' and r.state<>'released')
                   or exists(select 1 from calls c join call_legs l on l.call_id=c.id where c.id=t.call_id and c.ended_at is not null and l.ended_at is null))
               union all select distinct 'control',request->>'rootOperationId' from call_operations
                 where call_id=$1 and request->>'controlAction' is not null and resolved_at is null
               limit 16`,
                [row.id]
              )
            ).rows;
            for (const root of roots) {
              if (!current()) break;
              await workers[root.kind as "connection" | "transfer" | "control"].wakeExecutor(root.id);
            }
            if (!current()) break;
            if (
              (
                await pool.query(
                  `select 1 from calls c where c.id=$1 and c.direction='inbound' and
              ((c.ended_at is null and (c.state='fallback' or (c.state='queued' and c.queue_deadline_at<=clock_timestamp())))
                or exists(select 1 from call_operations o where o.call_id=c.id and o.request->>'inboundFallback'='true' and o.resolved_at is null))`,
                  [row.id]
                )
              ).rowCount
            )
              await workers.fallback.tick(row.id);
            const result = await recoverQuiescentCall(pool, executor, row.id, command, current);
            await workers.cleanup?.reconcile(row.id);
            calls.push({ callId: row.id, result });
          } catch (error) {
            if (error instanceof RecoveryObservationChanged) break;
            calls.push({ callId: row.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        // Keyset rotation prevents an unresolved old call monopolizing a batch.
        if (candidates.length < 8) cursor = null;
        return { status: current() ? ("complete" as const) : ("backlog" as const), calls };
      } finally {
        running = false;
      }
    }
  };
}
