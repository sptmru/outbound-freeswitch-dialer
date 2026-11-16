import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withCallAdmission, type CallAdmission } from "./call-admission.js";
import { enqueueCallCommand, type DurableCommand, type CallExecutor } from "./call-executor.js";
import { createCommandDriver, type BackgroundJobEvidence } from "./call-command-transport.js";
import { requestFingerprint } from "./call-coordination-contracts.js";
import type { AppConfig } from "./config.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import { CapacityError } from "./call-capacity.js";
import { reconcileCoordinatedCallCleanup } from "./call-cleanup.js";
import {
  forwardingDestination,
  inboundForwardingCommand,
  settleUnstartedForwarding,
  type ForwardingConfig
} from "./inbound-forwarding.js";
import { ingressUuid } from "./ingress-journal.js";

/** SQL-only timer/restart entry point. Acceptance and fallback share admission locks.
 * A pending operation is returned for wake-up, never permission to resend. */
async function advanceOnce(
  pool: pg.Pool,
  callId: string,
  checkpoint?: (a: CallAdmission) => Promise<void>,
  forwarding?: ForwardingConfig
): Promise<DurableCommand | null> {
  const db = await pool.connect();
  try {
    return await withCallAdmission(db, { callIds: [callId] }, async (a) => {
      const c = (
        await db.query(`select *, queue_deadline_at<=clock_timestamp() as due from calls where id=$1`, [
          callId
        ])
      ).rows[0];
      if (!c || c.direction !== "inbound") return null;
      const unresolved = (
        await db.query(
          `select * from call_operations where call_id=$1 and request->>'inboundFallback'='true' and resolved_at is null order by created_at limit 1`,
          [callId]
        )
      ).rows[0];
      if (unresolved) return unresolved;
      if (c.ended_at || !(c.state === "fallback" || (c.state === "queued" && c.due))) return null;
      // Never overtake an uncertain waiting/connection sender or unclean agent leg.
      if (
        (await db.query(`select 1 from call_operations where call_id=$1 and resolved_at is null`, [callId]))
          .rowCount ||
        (
          await db.query(
            `select 1 from call_legs where call_id=$1 and type<>'customer' and ended_at is null`,
            [callId]
          )
        ).rowCount
      )
        return null;
      let run = (await db.query("select * from inbound_fallback_runs where call_id=$1", [callId])).rows[0];
      if (!run) {
        const version = (
          await db.query(
            `select v.* from inbound_ingress_evidence e join inbound_flow_versions v
          on v.id::text=e.route_snapshot->'configuration'->>'no_answer_flow_version_id'
          and v.campaign_id=$2 where e.call_id=$1`,
            [callId, c.campaign_id]
          )
        ).rows[0];
        run = (
          await db.query(
            `insert into inbound_fallback_runs(call_id,flow_version_id,started_at,deadline_at)
          values($1,$2,clock_timestamp(),clock_timestamp()+$3::int*interval '1 millisecond') returning *`,
            [callId, version?.id ?? null, version?.flow_timeout_ms ?? 3000]
          )
        ).rows[0];
        await db.query(
          `update calls set state='fallback',fallback_started_at=coalesce(fallback_started_at,clock_timestamp()),queue_exited_at=coalesce(queue_exited_at,clock_timestamp()) where id=$1`,
          [callId]
        );
        await db.query(
          `update call_offers set state='canceled',reason='fallback_started',closed_at=clock_timestamp() where call_id=$1 and kind='inbound' and state='pending'`,
          [callId]
        );
        await db.query(
          `insert into call_events(call_id,event_type,state,raw_json) values($1,'inbound_fallback_entered','fallback',$2)`,
          [callId, { flowVersionId: run.flow_version_id }]
        );
      }
      const v = run.flow_version_id
        ? (await db.query("select * from inbound_flow_versions where id=$1", [run.flow_version_id])).rows[0]
        : null;
      const previous = (
        await db.query(
          `select * from call_operations where call_id=$1 and request->>'inboundFallback'='true' order by (request->>'step')::int desc limit 1`,
          [callId]
        )
      ).rows[0];
      if (previous?.command_kind === "hangup") return null;
      const step = previous ? Number(previous.request.step) + 1 : 0;
      const expired = (
        await db.query("select $1::timestamptz<=clock_timestamp() as expired", [run.deadline_at])
      ).rows[0].expired;
      const continueFlow =
        !previous ||
        (previous.command_kind === "forward_external"
          ? previous.result?.outcome !== "connected"
          : previous.state === "succeeded");
      const action = !expired && continueFlow ? v?.actions[step] : null;
      if (action?.type === "forward_external") {
        const destination = forwardingDestination(action.target, forwarding);
        if (destination) {
          await db.query("savepoint forward_claim");
          try {
            const participant = (
              await db.query(
                "insert into call_participants(call_id,role,external_number,joined_at) values($1,'external',$2,clock_timestamp()) returning id",
                [callId, action.target]
              )
            ).rows[0].id;
            const externalUuid = randomUUID();
            const leg = (
              await db.query(
                "insert into call_legs(call_id,participant_id,type,freeswitch_uuid,state,started_at) values($1,$2,'external',$3,'created',clock_timestamp()) returning id",
                [callId, participant, externalUuid]
              )
            ).rows[0].id;
            const deadline = (
              await db.query(
                "select least($1::timestamptz,clock_timestamp()+$2::int*interval '1 millisecond') as at",
                [run.deadline_at, action.timeoutMs]
              )
            ).rows[0].at;
            const request = {
              inboundFallback: true,
              step,
              flowVersionId: run.flow_version_id,
              action: "forward_external",
              externalUuid,
              participantId: participant,
              legId: leg,
              ...destination,
              deadlineEpoch: String(Math.floor(new Date(deadline).getTime() / 1000)),
              flowDeadlineEpoch: String(Math.floor(new Date(run.deadline_at).getTime() / 1000))
            };
            const { operation } = await enqueueCallCommand(a, {
              id: randomUUID(),
              callId,
              scope: `inbound-fallback:${callId}`,
              key: String(step),
              fingerprint: requestFingerprint("POST", "internal/inbound-fallback", callId, request),
              kind: "forward_external",
              generation: "1",
              commandUuid: randomUUID(),
              targetUuid: callId,
              request,
              deadline
            });
            await a.capacity.claim({
              kind: "forward",
              callId,
              operationId: operation.id,
              generation: "1",
              callLegId: leg
            });
            await checkpoint?.(a);
            await db.query("release savepoint forward_claim");
            return operation;
          } catch (error) {
            await db.query("rollback to savepoint forward_claim");
            if (!(error instanceof CapacityError) || error.reason !== "capacity_exceeded") throw error;
          }
        }
        // No sender or external participant was committed. Record a terminal step
        // so the next tick takes the finite saved continuation, never another dial.
        const { operation } = await enqueueCallCommand(a, {
          id: randomUUID(),
          callId,
          scope: `inbound-fallback:${callId}`,
          key: String(step),
          fingerprint: requestFingerprint("POST", "internal/inbound-fallback", callId, { step }),
          kind: "forward_external",
          generation: "1",
          commandUuid: randomUUID(),
          targetUuid: callId,
          request: { inboundFallback: true, step, flowVersionId: run.flow_version_id },
          deadline: run.deadline_at
        });
        await db.query(
          "update call_operations set state='failed',resolved_at=clock_timestamp(),result=$2,resolution_evidence='forwarding refused before sender' where id=$1",
          [
            operation.id,
            { outcome: "failed", reason: destination ? "capacity_exceeded" : "forwarding_unconfigured" }
          ]
        );
        await checkpoint?.(a);
        return null;
      }
      // Playback continuation reuses the retained customer and original flow deadline.
      const play = action?.type === "play_audio";
      const asset = play
        ? v.audio_snapshot.find((x: { recordingId: string }) => x.recordingId === action.recordingId)
        : null;
      const request = {
        inboundFallback: true,
        step,
        flowVersionId: run.flow_version_id,
        action: play ? "play_audio" : "hangup",
        audio: asset?.runtimeFilePath ?? null,
        reason: expired
          ? "flow_deadline"
          : previous && previous.state !== "succeeded"
            ? previous.command_kind === "forward_external"
              ? "forward_failed"
              : "playback_failed"
            : "flow_complete",
        deadlineEpoch: String(Math.floor(new Date(run.deadline_at).getTime() / 1000))
      };
      const deadline = (
        await db.query(
          `select case when $1 then least($2::timestamptz,clock_timestamp()+$3::int*interval '1 millisecond') else clock_timestamp()+interval '3 seconds' end as at`,
          [play, run.deadline_at, action?.timeoutMs ?? 3000]
        )
      ).rows[0].at;
      if (play) request.deadlineEpoch = String(Math.floor(new Date(deadline).getTime() / 1000));
      const { operation } = await enqueueCallCommand(a, {
        id: randomUUID(),
        callId,
        scope: `inbound-fallback:${callId}`,
        key: String(step),
        fingerprint: requestFingerprint("POST", "internal/inbound-fallback", callId, request),
        kind: play ? "play_audio" : "hangup",
        generation: "1",
        commandUuid: randomUUID(),
        targetUuid: callId,
        request,
        deadline
      });
      await checkpoint?.(a);
      return operation;
    });
  } finally {
    db.release();
  }
}
export async function advanceInboundFallback(
  pool: pg.Pool,
  callId: string,
  checkpoint?: (a: CallAdmission) => Promise<void>,
  forwarding?: ForwardingConfig
): Promise<DurableCommand | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await advanceOnce(pool, callId, checkpoint, forwarding);
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || error.message !== "discovery_changed") throw error;
    }
  }
}
export function inboundFallbackCommand(op: DurableCommand) {
  assert.ok(
    op.request.inboundFallback &&
      ingressUuid.test(op.id) &&
      ingressUuid.test(op.call_id) &&
      op.target_uuid === op.call_id
  );
  if (op.command_kind === "forward_external") return inboundForwardingCommand(op);
  if (op.command_kind === "hangup") return `uuid_kill ${op.call_id} NORMAL_CLEARING`;
  const path = op.request.audio;
  assert.ok(typeof path === "string" && /^\/[A-Za-z0-9_./-]+$/.test(path) && !path.split("/").includes(".."));
  assert.match(String(op.request.deadlineEpoch), /^[1-9][0-9]{9,11}$/);
  return `uuid_transfer ${op.call_id} inbound_fallback:${op.id}:${op.request.deadlineEpoch}:${path} XML inbound-fallback`;
}
export async function persistInboundFallbackJob(db: pg.Pool | pg.PoolClient, job: BackgroundJobEvidence) {
  if (!ingressUuid.test(job.jobUuid)) return false;
  const op = (
    await db.query(
      `select * from call_operations where command_uuid=$1 and request->>'inboundFallback'='true'`,
      [job.jobUuid]
    )
  ).rows[0];
  if (!op) return false;
  await db.query(
    `insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,raw_json) values($1,'inbound_fallback_job','BACKGROUND_JOB',$2,$3) on conflict do nothing`,
    [op.call_id, job.headers["event-uuid"] ?? null, { jobUuid: job.jobUuid, body: job.body.slice(0, 4096) }]
  );
  return true;
}
export async function persistInboundFallbackEvent(pool: pg.Pool, h: Record<string, string>) {
  const type = h["event-subclass"]?.replace("outbound_dialer::inbound_fallback_", "");
  if (h["event-name"] !== "CUSTOM" || !["started", "completed", "failed"].includes(type)) return false;
  const id = h["outbound-dialer-operation-id"],
    callId = h["outbound-dialer-call-id"];
  if (!ingressUuid.test(id ?? "") || !ingressUuid.test(callId ?? "") || h["unique-id"] !== callId)
    return true;
  await pool.query(
    `insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,customer_leg_uuid,raw_json)
    select o.call_id,$3,'CUSTOM',$4,o.target_uuid,$5 from call_operations o
    where o.id=$1 and o.call_id=$2::uuid and o.target_uuid=$2::uuid and o.request->>'inboundFallback'='true' and o.command_kind='play_audio'
    and exists(select 1 from call_execution_attempts where operation_id=o.id) on conflict do nothing`,
    [id, callId, `inbound_fallback_${type}`, h["event-uuid"] ?? null, { operationId: id, headers: h }]
  );
  return true;
}
export async function resolveInboundFallback(
  op: DurableCommand,
  db: pg.Pool | pg.PoolClient,
  absent?: (uuid: string) => Promise<boolean>
) {
  const job = (
    await db.query(
      `select raw_json from call_events where call_id=$1 and event_type='inbound_fallback_job' and raw_json->>'jobUuid'=$2 limit 1`,
      [op.call_id, op.command_uuid]
    )
  ).rows[0]?.raw_json;
  if (!job) return null; // Even terminal channel evidence cannot fence a delayed sender.
  if (op.command_kind === "forward_external") {
    const finished = (
      await db.query(
        "select 1 from call_events where call_id=$1 and event_type='inbound_forward_finished' and raw_json->>'operationId'=$2",
        [op.call_id, op.id]
      )
    ).rowCount;
    // The transfer job finishes before Lua's bridge. Only the Lua return fences
    // that asynchronous sender; customer termination alone is insufficient.
    if (!finished && !String(job.body).trim().startsWith("-ERR")) return null;
    const leg = (
      await db.query(
        "select l.*,p.connected_at from call_legs l join call_participants p on p.id=l.participant_id where l.id=$1",
        [op.request.legId]
      )
    ).rows[0];
    if (!leg) return null;
    if (!leg.ended_at && absent && (await absent(String(op.request.externalUuid)))) {
      // The fixed job and Lua completion above fence every producer before probing.
      await db.query(
        "update call_legs set state='ended',ended_at=clock_timestamp() where id=$1 and ended_at is null",
        [leg.id]
      );
      await db.query(
        "update call_participants set left_at=coalesce(left_at,clock_timestamp()),end_reason=coalesce(end_reason,'finished_forward_channel_absent') where id=$1",
        [leg.participant_id]
      );
      leg.ended_at = new Date();
    }
    if (!leg.ended_at) return null;
    return {
      state: leg.connected_at ? ("succeeded" as const) : ("failed" as const),
      result: { outcome: leg.connected_at ? "connected" : "failed" },
      evidence: "fixed transfer job and finished native bridge; exact external cleanup"
    };
  }
  const events = (
    await db.query(`select event_type from call_events where call_id=$1 and raw_json->>'operationId'=$2`, [
      op.call_id,
      op.id
    ])
  ).rows.map((r) => r.event_type);
  const ended = (
    await db.query(
      `select 1 from call_legs where call_id=$1::uuid and freeswitch_uuid=$1::text and ended_at is not null`,
      [op.call_id]
    )
  ).rowCount;
  let outcome: string | null = null;
  if (op.command_kind === "hangup" && ended) outcome = "completed";
  else if (!String(job.body).trim().startsWith("+OK")) outcome = "failed";
  else if (events.includes("inbound_fallback_completed")) outcome = "completed";
  else if (events.includes("inbound_fallback_failed")) outcome = "failed";
  else if (ended) outcome = "interrupted";
  if (!outcome) return null;
  return {
    state: outcome === "completed" ? ("succeeded" as const) : ("failed" as const),
    result: { outcome },
    evidence: `fixed fallback job finished; exact ${outcome} effect`
  };
}
/** Bounded explicit staged worker; I05 owns scheduling/bootstrap. */
export function inboundFallbackExecutor(
  pool: pg.Pool,
  executor: CallExecutor,
  esl: { host: string; port: number; password: string },
  forwarding?: ForwardingConfig
) {
  const absent = async (uuid: string) =>
    (
      await sendFreeSwitchApiCommand(
        {
          FREESWITCH_ESL_HOST: esl.host,
          FREESWITCH_ESL_PORT: esl.port,
          FREESWITCH_ESL_PASSWORD: esl.password
        } as AppConfig,
        `uuid_exists ${uuid}`,
        1000
      )
    ).body.trim() === "false";
  const driver = createCommandDriver({
    ...esl,
    buildCommand: inboundFallbackCommand,
    async validate(op, a) {
      if (
        op.command_kind === "forward_external" &&
        (
          await a.client.query(
            "select count(*)::int n from call_capacity_reservations where operation_id=$1 and call_leg_id::text=$2 and state<>'released'",
            [op.id, op.request.legId]
          )
        ).rows[0].n !== 3
      )
        return false;
      return Boolean(
        (
          await a.client.query(
            `select 1 from inbound_fallback_runs r join calls c on c.id=r.call_id where r.call_id=$1 and c.state='fallback' and c.ended_at is null`,
            [op.call_id]
          )
        ).rowCount
      );
    },
    async verify(op, job, _signal, db) {
      await persistInboundFallbackJob(db, job);
      return resolveInboundFallback(op, db, absent);
    },
    async reconcile(op, _signal, db) {
      return resolveInboundFallback(op, db, absent);
    }
  });
  return {
    async tick(callId: string) {
      for (let attempt = 0; ; attempt++) {
        try {
          await settleUnstartedForwarding(pool, callId);
          await reconcileCoordinatedCallCleanup(pool, callId);
          const op = await advanceInboundFallback(pool, callId, undefined, forwarding);
          if (op) {
            const result = await executor.run(
              op.id,
              op.command_kind === "hangup" ? "critical" : "normal",
              driver
            );
            await reconcileCoordinatedCallCleanup(pool, callId);
            return result;
          }
          return null;
        } catch (error) {
          if (attempt >= 2 || !(error instanceof Error) || error.message !== "discovery_changed") throw error;
        }
      }
    },
    async reconcile() {
      const rows = await pool.query(`select c.id from calls c where c.direction='inbound' and
      ((c.ended_at is null and (c.state='fallback' or (c.state='queued' and c.queue_deadline_at<=clock_timestamp())))
       or exists(select 1 from call_operations o where o.call_id=c.id and o.request->>'inboundFallback'='true' and o.resolved_at is null)) order by c.arrived_at,c.id limit 8`);
      for (const r of rows.rows) await this.tick(r.id);
    }
  };
}
