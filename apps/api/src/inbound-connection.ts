import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import type { SlotToken } from "./agent-call-slots.js";
import { withCallAdmission, type CallAdmission } from "./call-admission.js";
import { enqueueCallCommand, type CallExecutor, type DurableCommand } from "./call-executor.js";
import { createCommandDriver, type BackgroundJobEvidence } from "./call-command-transport.js";
import { reconcileCoordinatedCallCleanup } from "./call-cleanup.js";
import { inboundRetryDelay } from "./inbound-acceptance.js";
import { ingressUuid } from "./ingress-journal.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import { verifiedDeskContact } from "./desk-sessions.js";
import { finishAgentCall } from "./agent-availability.js";

export function inboundConnectionCommand(op: DurableCommand) {
  const r = op.request;
  assert.ok(
    r.inboundConnection &&
      ingressUuid.test(op.call_id) &&
      ingressUuid.test(op.target_uuid ?? "") &&
      ingressUuid.test(String(r.agentUuid))
  );
  switch (r.connectionAction) {
    case "originate": {
      const endpoint = String(r.endpoint);
      // Only a D01-verified literal contact, never a browser-provided dial string.
      assert.equal(verifiedDeskContact(endpoint, String(r.sipUsername)), endpoint);
      assert.equal(op.target_uuid, r.agentUuid);
      const intent = r.intent as { deskSessionId: string; bindingGeneration: string };
      assert.ok(ingressUuid.test(intent.deskSessionId) && /^[1-9][0-9]*$/.test(intent.bindingGeneration));
      return `originate {origination_uuid=${op.target_uuid},originate_timeout=4,ignore_early_media=true,hangup_after_bridge=true,outbound_dialer_call_id=${op.call_id},sip_h_X-Outbound-Dialer-Call-ID=${op.call_id},sip_h_X-Outbound-Dialer-Operation-ID=${op.id},sip_h_X-Outbound-Dialer-Desk-Session-ID=${intent.deskSessionId},sip_h_X-Outbound-Dialer-Binding-Generation=${intent.bindingGeneration}}${endpoint} &park()`;
    }
    case "bridge":
      return `uuid_bridge ${op.call_id} ${r.agentUuid}`;
    case "cancel_guard":
      return `sched_del ${op.call_id}`;
    case "cleanup":
      return `uuid_kill ${r.agentUuid} NORMAL_CLEARING`;
    default:
      throw new Error("Unsupported inbound connection action");
  }
}

export async function validateInboundConnection(op: DurableCommand, a: CallAdmission) {
  const r = op.request,
    s = r.slot as SlotToken;
  if (!s || s.callId !== op.call_id || s.generation !== op.generation) return false;
  const row = (
    await a.client.query(
      `select c.*,l.ended_at as leg_ended,d.verified_at>clock_timestamp()-interval '15 seconds' as verified_recent from inbound_connection_attempts x
    join calls c on c.id=x.call_id join call_participants p on p.id=x.participant_id
    join call_legs l on l.participant_id=p.id join agent_call_slots s on s.participant_id=p.id
    join agent_desk_sessions d on d.id=$6 join agents ag on ag.id=x.agent_id join users u on u.id=ag.user_id
    where x.operation_id=$1 and x.call_id=$2 and x.participant_id=$3 and x.settled_at is null
      and s.call_id=c.id and s.agent_id=x.agent_id and s.reservation_id=$4 and s.generation=$5
      and p.slot_reservation_id=s.reservation_id and p.slot_generation=s.generation
      and s.state in ('connecting','active') and not s.reconciliation_required
      and d.agent_id=s.agent_id and d.revoked_at is null and d.expires_at>clock_timestamp()
      and d.revision=$7 and d.binding_generation=$8 and d.verified_generation=d.binding_generation
      and d.ready and d.verified_endpoint=$9 and u.id=$10 and u.is_active and u.auth_version=$11
      and d.actor_auth_version=u.auth_version and ag.availability_status='available'
      and not exists(select 1 from system_settings where key='ops.call_start_paused' and value_json='true'::jsonb)
      and l.freeswitch_uuid=$12 and p.left_at is null`,
      [
        r.rootOperationId,
        op.call_id,
        r.participantId,
        s.reservationId,
        s.generation,
        (r.intent as { deskSessionId: string }).deskSessionId,
        (r.intent as { expectedRevision: string }).expectedRevision,
        (r.intent as { bindingGeneration: string }).bindingGeneration,
        r.endpoint,
        r.actorUserId,
        r.actorAuthVersion,
        r.agentUuid
      ]
    )
  ).rows[0];
  if (!row || row.ended_at || row.leg_ended) return false;
  if (r.connectionAction === "cancel_guard") return row.state === "agent_connected";
  return row.state === "connecting" && row.verified_recent;
}

export async function persistInboundConnectionJob(db: pg.Pool | pg.PoolClient, job: BackgroundJobEvidence) {
  if (!ingressUuid.test(job.jobUuid)) return false;
  const op = (
    await db.query(
      "select id,call_id from call_operations where command_uuid=$1 and request->>'inboundConnection'='true'",
      [job.jobUuid]
    )
  ).rows[0];
  if (!op) return false;
  await db.query(
    "insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,raw_json) values($1,'inbound_connection_job','BACKGROUND_JOB',$2,$3) on conflict do nothing",
    [
      op.call_id,
      job.headers["event-uuid"] ?? null,
      { operationId: op.id, jobUuid: job.jobUuid, body: job.body.slice(0, 4096) }
    ]
  );
  return true;
}

/** Result requires a fixed completed job plus the concrete effect. Absence is
 * consulted ONLY after that job: its single-frame sender can have no later send.
 * Missing job/early absence/deadline never frees uncertainty.
 */
async function resolution(
  op: DurableCommand,
  db: pg.PoolClient,
  absent: (uuid: string) => Promise<boolean>,
  signal: AbortSignal
) {
  if (signal.aborted) return null;
  const job = (
    await db.query(
      "select raw_json from call_events where call_id=$1 and event_type='inbound_connection_job' and raw_json->>'jobUuid'=$2 order by created_at limit 1",
      [op.call_id, op.command_uuid]
    )
  ).rows[0]?.raw_json;
  if (!job || signal.aborted) return null;
  const action = op.request.connectionAction;
  const positive = String(job.body).trim().startsWith("+OK");
  const leg = (
    await db.query("select * from call_legs where call_id=$1 and freeswitch_uuid=$2 and participant_id=$3", [
      op.call_id,
      op.request.agentUuid,
      op.request.participantId
    ])
  ).rows[0];
  if (!leg || signal.aborted) return null;
  let state: "succeeded" | "failed" | undefined;
  if (action === "originate" || action === "cleanup") {
    const customerEnded =
      action === "originate" &&
      Boolean((await db.query("select ended_at from calls where id=$1", [op.call_id])).rows[0]?.ended_at);
    if (customerEnded)
      state = "failed"; // fixed sender finished; its live leg still needs exact cleanup
    else if (leg.ended_at) state = action === "cleanup" ? "succeeded" : "failed";
    else if (action === "originate" && positive && leg.answered_at) state = "succeeded";
    else if (await absent(String(op.request.agentUuid))) {
      if (signal.aborted) return null;
      await withCallAdmission(db, { callIds: [op.call_id] }, async () => {
        await db.query(
          "update call_legs set state='ended',ended_at=coalesce(ended_at,clock_timestamp()) where id=$1",
          [leg.id]
        );
        await db.query(
          "update call_participants set left_at=coalesce(left_at,clock_timestamp()),end_reason=coalesce(end_reason,'fixed_job_complete_channel_absent') where id=$1",
          [leg.participant_id]
        );
        await db.query(
          "insert into call_events(call_id,event_type,agent_leg_uuid,raw_json) values($1,'inbound_connection_absent',$2,$3)",
          [op.call_id, op.request.agentUuid, { jobUuid: op.command_uuid, operationId: op.id }]
        );
      });
      state = action === "cleanup" ? "succeeded" : "failed";
    }
  } else if (action === "bridge") {
    const bridged = (
      await db.query("select 1 from call_participants where id=$1 and connected_at is not null", [
        op.request.participantId
      ])
    ).rowCount;
    if (bridged) state = "succeeded";
    else if (!positive || leg.ended_at) state = "failed";
  } else if (action === "cancel_guard") state = positive ? "succeeded" : "failed";
  return state
    ? {
        state,
        result: { jobUuid: op.command_uuid },
        evidence: "fixed job complete and exact persisted inbound connection effect"
      }
    : null;
}

/** SQL failure/requeue coordinator. No uncertain operation can be replaced; all
 * original permits survive until every possible sender and concrete leg resolve.
 */
export async function settleInboundConnection(pool: pg.Pool, rootId: string) {
  const root = (
    await pool.query("select * from call_operations where id=$1 and request->>'inboundConnection'='true'", [
      rootId
    ])
  ).rows[0] as DurableCommand | undefined;
  if (!root) return null;
  const db = await pool.connect();
  try {
    return await withCallAdmission(db, { callIds: [root.call_id] }, async (a) => {
      const x = (await db.query("select * from inbound_connection_attempts where operation_id=$1", [rootId]))
        .rows[0];
      if (!x || x.settled_at) return null;
      const call = (await db.query("select * from calls where id=$1", [root.call_id])).rows[0];
      const ops = (
        await db.query("select * from call_operations where call_id=$1 and request->>'rootOperationId'=$2", [
          root.call_id,
          rootId
        ])
      ).rows as DurableCommand[];
      if (ops.some((o) => ["executing", "uncertain"].includes(o.state))) return null;
      const allSucceeded = ops
        .filter((o) => o.request.connectionAction !== "cleanup")
        .every((o) => o.state === "succeeded");
      if (
        call.state === "agent_connected" &&
        !call.ended_at &&
        (allSucceeded || ops.every((o) => ["succeeded", "failed", "canceled"].includes(o.state)))
      ) {
        await db.query(
          "update inbound_connection_attempts set settled_at=clock_timestamp(),outcome='connected' where operation_id=$1",
          [rootId]
        );
        const queue = (
          await db.query(
            "select * from call_capacity_reservations where call_id=$1 and resource_type='queue_waiting' and state<>'released'",
            [root.call_id]
          )
        ).rows;
        for (const r of queue)
          await a.capacity.release(
            { id: r.id, callId: r.call_id, operationId: r.operation_id, generation: r.generation },
            true
          );
        return null;
      }
      const failed =
        call.ended_at ||
        ops.some((o) => ["failed", "canceled"].includes(o.state)) ||
        (
          await db.query(
            "select deadline_at<=clock_timestamp() as expired from inbound_connection_attempts where operation_id=$1",
            [rootId]
          )
        ).rows[0].expired;
      if (!failed) return null;
      // Unstarted children can never send after failure. Sent uncertainty was
      // ruled out above; the call execution lock still fences all actual senders.
      await db.query(
        "update call_operations set state='canceled',resolved_at=clock_timestamp(),resolution_evidence='inbound connection closed before this sender started' where call_id=$1 and request->>'rootOperationId'=$2 and request->>'connectionAction'<>'cleanup' and state='pending'",
        [root.call_id, rootId]
      );
      const leg = (await db.query("select * from call_legs where participant_id=$1", [x.participant_id]))
        .rows[0];
      const attempted = (
        await db.query("select 1 from call_execution_attempts where operation_id=$1", [rootId])
      ).rowCount;
      if (!attempted && !leg.ended_at) {
        await db.query("update call_legs set state='ended',ended_at=clock_timestamp() where id=$1", [leg.id]);
        await db.query(
          "update call_participants set left_at=clock_timestamp(),end_reason='originate_never_attempted' where id=$1",
          [x.participant_id]
        );
        leg.ended_at = new Date();
      }
      if (!leg.ended_at) {
        const old = ops.find((o) => o.request.connectionAction === "cleanup");
        if (old) return old.state === "pending" ? old.id : null;
        const id = randomUUID();
        await enqueueCallCommand(a, {
          id,
          callId: root.call_id,
          scope: `inbound-cleanup:${rootId}`,
          key: "cleanup",
          fingerprint: "0".repeat(64),
          kind: "hangup",
          generation: root.generation,
          commandUuid: randomUUID(),
          targetUuid: String(root.request.agentUuid),
          request: { ...root.request, connectionAction: "cleanup", dependsOn: null },
          deadline: (await db.query("select clock_timestamp()+interval '30 seconds' as at")).rows[0].at
        });
        return id;
      }
      if (
        (
          await db.query("select 1 from call_operations where call_id=$1 and resolved_at is null", [
            root.call_id
          ])
        ).rowCount
      )
        return null;
      const s = root.request.slot as SlotToken;
      const released = await a.release(s, true);
      for (const r of (
        await db.query(
          "select * from call_capacity_reservations where call_id=$1 and call_leg_id=$2 and state<>'released'",
          [root.call_id, leg.id]
        )
      ).rows)
        await a.capacity.release(
          { id: r.id, callId: r.call_id, operationId: r.operation_id, generation: r.generation },
          true
        );
      if (!call.ended_at && !call.agent_connected_at && call.state === "connecting") {
        const clock = (
          await db.query(
            "select clock_timestamp() as now,extract(epoch from queue_deadline_at)*1000 as deadline from calls where id=$1",
            [root.call_id]
          )
        ).rows[0];
        const backoff = inboundRetryDelay(x.attempt, clock.now.getTime(), Number(clock.deadline));
        const outcome = backoff === null ? "fallback" : "requeued";
        const retryAt = backoff === null ? null : new Date(clock.now.getTime() + backoff);
        await db.query(
          "update calls set state=$2,agent_id=null,fallback_started_at=case when $2='fallback' then clock_timestamp() else fallback_started_at end,updated_at=clock_timestamp() where id=$1",
          [root.call_id, backoff === null ? "fallback" : "queued"]
        );
        await db.query(
          "update inbound_connection_attempts set settled_at=clock_timestamp(),outcome=$2,retry_at=$3 where operation_id=$1",
          [rootId, outcome, retryAt]
        );
      } else
        await db.query(
          "update inbound_connection_attempts set settled_at=clock_timestamp(),outcome=$2 where operation_id=$1",
          [rootId, call.ended_at ? "ended" : "connected"]
        );
      if (released) await finishAgentCall(db, s.agentId);
      await db.query(
        "insert into call_events(call_id,agent_id,event_type,state,raw_json) values($1,$2,'inbound_connection_settled',(select state from calls where id=$1),$3)",
        [root.call_id, s.agentId, { operationId: rootId, attempt: x.attempt }]
      );
      return null;
    });
  } finally {
    db.release();
  }
}

export function inboundConnectionExecutor(
  pool: pg.Pool,
  executor: CallExecutor,
  esl: { host: string; port: number; password: string }
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
    buildCommand: inboundConnectionCommand,
    async validate(op, a) {
      if (op.request.connectionAction === "cleanup")
        return Boolean(
          (
            await a.client.query(
              "select 1 from call_legs where call_id=$1 and participant_id=$2 and freeswitch_uuid=$3",
              [op.call_id, op.request.participantId, op.request.agentUuid]
            )
          ).rowCount
        );
      return validateInboundConnection(op, a);
    },
    async verify(op, job, signal, db) {
      await persistInboundConnectionJob(db, job);
      while (!signal.aborted) {
        const result = await resolution(op, db, absent, signal);
        if (result) return result;
        await delay(20, undefined, { signal });
      }
      return null;
    },
    async reconcile(op, signal, db) {
      return resolution(op, db, absent, signal);
    }
  });
  return {
    async wakeExecutor(rootId: string) {
      const root = (
        await pool.query(
          "select * from call_operations where id=$1 and request->>'inboundConnection'='true'",
          [rootId]
        )
      ).rows[0];
      if (!root) throw new Error("Inbound connection root not found");
      const x = (
        await pool.query("select * from inbound_connection_attempts where operation_id=$1", [rootId])
      ).rows[0];
      if (!x || x.settled_at) return;
      for (const id of [x.operation_id, x.bridge_operation_id, x.guard_operation_id]) {
        const result = await executor.run(id, "normal", driver);
        if (result.status !== "terminal" || result.operation.state !== "succeeded") break;
      }
      const existingCleanup = (
        await pool.query(
          "select id from call_operations where call_id=$1 and request->>'rootOperationId'=$2 and request->>'connectionAction'='cleanup'",
          [root.call_id, rootId]
        )
      ).rows[0];
      if (existingCleanup) await executor.run(existingCleanup.id, "critical", driver);
      const cleanup = await settleInboundConnection(pool, rootId);
      if (cleanup) {
        await executor.run(cleanup, "critical", driver);
        await settleInboundConnection(pool, rootId);
      }
      if (
        (
          await pool.query(
            `select 1 from calls c where c.id=$1 and (c.ended_at is not null or
        exists(select 1 from call_participants p where p.call_id=c.id and p.left_at is not null))`,
            [root.call_id]
          )
        ).rowCount
      )
        await reconcileCoordinatedCallCleanup(pool, root.call_id);
    },
    async reconcile() {
      const rows = (
        await pool.query(
          "select operation_id from inbound_connection_attempts where settled_at is null order by deadline_at,operation_id limit 8"
        )
      ).rows;
      for (const row of rows) await this.wakeExecutor(row.operation_id);
    }
  };
}
