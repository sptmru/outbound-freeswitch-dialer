import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import type { SupervisorMode, SupervisorSession } from "@outbound-dialer/shared";
import { withCallAdmission, AdmissionDiscoveryChanged, type CallAdmission } from "./call-admission.js";
import { enqueueCallCommand, type CallExecutor, type DurableCommand } from "./call-executor.js";
import { createCommandDriver, type BackgroundJobEvidence } from "./call-command-transport.js";
import { requestFingerprint } from "./call-coordination-contracts.js";
import { buildSupervisorEavesdropOriginateCommand } from "./esl.js";
import type { AppConfig } from "./config.js";

export class SupervisorCoordinationError extends Error {}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function supervisorEndpointRoute(value: string) {
  const route = value.trim();
  if (!/^sofia\/internal-webrtc\/[^\s,|{}'"\\<>]+$/.test(route) || route.includes("&"))
    throw new SupervisorCoordinationError("Supervisor phone must have one verified registration");
  return route;
}
function snapshot(s: any): SupervisorSession {
  return {
    id: s.id,
    callId: s.call_id,
    mode: s.mode,
    state: s.state,
    startedAt: s.started_at.toISOString(),
    connectedAt: s.connected_at?.toISOString() ?? null,
    endedAt: s.ended_at?.toISOString() ?? null,
    failureReason: s.failure_reason
  };
}
async function actor(a: CallAdmission, userId: string, version: number, requireFree: boolean) {
  const db = a.client;
  if (
    !(
      await db.query("select 1 from users where id=$1 and is_active and role='admin' and auth_version=$2", [
        userId,
        version
      ])
    ).rowCount
  )
    throw new SupervisorCoordinationError("Administrator access changed; sign in again");
  if (
    requireFree &&
    (
      await db.query(
        `select 1 from agents a left join agent_call_slots s on s.agent_id=a.id
    where a.user_id=$1 and ((s.state<>'free') or exists(select 1 from calls c where c.agent_id=a.id
      and c.ended_at is null and c.agent_released_at is null and c.state not in ('completed','failed','canceled','agent_released')))`,
        [userId]
      )
    ).rowCount
  )
    throw new SupervisorCoordinationError("Finish your own Agent Desk call before monitoring another call");
}
async function target(db: pg.PoolClient, callId: string, userId: string) {
  const call = (
    await db.query(`select c.*,a.user_id from calls c join agents a on a.id=c.agent_id where c.id=$1`, [
      callId
    ])
  ).rows[0];
  if (
    !call ||
    call.user_id === userId ||
    call.ended_at ||
    !["bridged", "agent_connected", "voicemail_signal_detected"].includes(call.state) ||
    (await db.query("select 1 from call_transfers where call_id=$1 and closed_at is null", [callId])).rowCount
  )
    throw new SupervisorCoordinationError("Call is no longer available for live monitoring");
  const legs = (
    await db.query(
      `select l.* from call_legs l left join call_participants p on p.id=l.participant_id
    where l.call_id=$1 and l.ended_at is null and l.freeswitch_uuid is not null and l.type in ('agent','customer')
      and (l.participant_id is null or (p.left_at is null and (p.role='customer' or p.agent_id=$2)))`,
      [callId, call.agent_id]
    )
  ).rows;
  const agent = legs.filter((l) => l.type === "agent"),
    customer = legs.filter((l) => l.type === "customer");
  if (agent.length !== 1 || customer.length !== 1)
    throw new SupervisorCoordinationError("Call media changed; refresh before monitoring");
  return { agent: agent[0].freeswitch_uuid as string, customer: customer[0].freeswitch_uuid as string };
}

/** Called under common admission for an accepted transfer. Cancel only unsent
 * work; an uncertain mode/originate must finish reconciliation before teardown.
 * Each exact generation receives one immutable stop, without changing its owner.
 */
export async function prepareSupervisorHandover(a: CallAdmission, callId: string, transferId: string) {
  const db = a.client;
  const work: string[] = [];
  const sessions = (
    await db.query(
      "select * from call_supervisor_sessions where call_id=$1 and state in ('connecting','active') order by id",
      [callId]
    )
  ).rows;
  for (const s of sessions) {
    // A legacy sender cannot provide native fixed-job quiescence. Keep the
    // transfer blocked until its own operator/legacy teardown completes.
    if (s.coordination_protocol !== "native") continue;
    await db.query(
      `update call_operations set state='canceled',resolved_at=clock_timestamp(),
        resolution_evidence='transfer handover canceled unstarted supervisor work'
        where request->>'supervisorSessionId'=$1 and state='pending'
          and coalesce(request->>'supervisorAction','')<>'handover'`,
      [s.id]
    );
    await db.query(
      `update supervisor_leg_evidence e set ended_at=clock_timestamp(),terminal_evidence='resolved originate without a live channel'
       from call_operations o where e.session_id=$1 and e.originate_operation_id=o.id
         and o.state in ('failed','canceled') and e.ended_at is null`,
      [s.id]
    );
    const unresolved = (
      await db.query(
        "select id from call_operations where request->>'supervisorSessionId'=$1 and resolved_at is null order by id",
        [s.id]
      )
    ).rows;
    if (unresolved.length) {
      work.push(...unresolved.map((o) => o.id));
      continue;
    }
    if (
      !(
        await db.query("select 1 from supervisor_leg_evidence where session_id=$1 and ended_at is null", [
          s.id
        ])
      ).rowCount
    )
      continue;
    const existing = (
      await db.query(
        "select id from call_operations where request->>'supervisorSessionId'=$1 and request->>'supervisorAction'='handover' and generation=$2",
        [s.id, s.generation]
      )
    ).rows[0];
    if (existing) continue;
    const id = randomUUID();
    await enqueueCallCommand(a, {
      id,
      callId,
      scope: `supervisor-handover:${s.id}`,
      key: s.generation,
      fingerprint: requestFingerprint("POST", "supervisor-handover", s.id, { generation: s.generation }),
      kind: "hangup",
      generation: s.generation,
      commandUuid: randomUUID(),
      targetUuid: s.supervisor_leg_uuid,
      request: {
        supervisorSessionId: s.id,
        supervisorAction: "handover",
        rootOperationId: id,
        transferId,
        actorUserId: s.actor_user_id
      },
      deadline: (await db.query("select clock_timestamp()+interval '30 seconds' as deadline")).rows[0]
        .deadline
    });
    await db.query(
      "update call_supervisor_sessions set control_root_id=$2,state='connecting',updated_at=clock_timestamp() where id=$1",
      [s.id, id]
    );
    work.push(id);
  }
  return work;
}

export async function supervisionQuiescent(db: pg.Pool | pg.PoolClient, callId: string) {
  return !(
    await db.query(
      `select 1 where exists(select 1 from call_supervisor_sessions where call_id=$1 and state in ('connecting','active'))
      or exists(select 1 from supervisor_leg_evidence where call_id=$1 and ended_at is null)
      or exists(select 1 from call_operations where call_id=$1 and request ? 'supervisorSessionId' and resolved_at is null)
      or exists(select 1 from call_capacity_reservations where call_id=$1 and supervisor_session_id is not null and state<>'released')`,
      [callId]
    )
  ).rowCount;
}

/** The transfer executor can reconcile old sends and execute fixed stops, but
 * this driver can never originate or replace monitoring on the recipient. */
export function supervisorHandoverDriver(
  esl: { host: string; port: number; password: string },
  probe: (command: string, signal: AbortSignal) => Promise<string>
) {
  return createCommandDriver({
    ...esl,
    buildCommand(op) {
      if (op.command_kind !== "hangup" || !uuid.test(op.target_uuid ?? ""))
        throw new Error("Handover permits only exact supervisor teardown");
      return `uuid_kill ${op.target_uuid} NORMAL_CLEARING`;
    },
    validate,
    async verify(op, job, signal, db) {
      await persistSupervisorJob(db, job);
      while (!signal.aborted) {
        const result = await resolution(
          op,
          db,
          async (id, s) => (await probe(`uuid_exists ${id}`, s)).trim() === "false",
          signal
        );
        if (result) return result;
        await delay(20, undefined, { signal });
      }
      return null;
    },
    reconcile: (op, signal, db) =>
      resolution(op, db, async (id, s) => (await probe(`uuid_exists ${id}`, s)).trim() === "false", signal)
  });
}
export interface SupervisorMutation {
  action: "start" | "mode" | "stop";
  actorUserId: string;
  actorAuthVersion: number;
  callId?: string;
  sessionId?: string;
  mode?: SupervisorMode;
  key: string;
  // Trusted server-side result of exact sofia_contact lookup, never HTTP input.
  endpoint?: { sipUsername: string; route: string };
}
export async function admitSupervisorMutation(pool: pg.Pool, input: SupervisorMutation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await admitSupervisorMutationOnce(pool, input);
    } catch (error) {
      // Discovery changed before the gate: the rolled-back SQL-only attempt
      // cannot have sent media. Rediscover the entire set, never reuse locks.
      if (!(error instanceof AdmissionDiscoveryChanged) || attempt >= 2) throw error;
    }
  }
}
async function admitSupervisorMutationOnce(pool: pg.Pool, input: SupervisorMutation) {
  const db = await pool.connect();
  try {
    const callId =
      input.callId ??
      (
        await db.query("select call_id from call_supervisor_sessions where id=$1 and actor_user_id=$2", [
          input.sessionId,
          input.actorUserId
        ])
      ).rows[0]?.call_id;
    if (!callId || !uuid.test(input.key))
      throw new SupervisorCoordinationError("Supervisor session or request identity is invalid");
    return await withCallAdmission(
      db,
      {
        callIds: [callId],
        userIds: [input.actorUserId],
        startsCall: input.action !== "stop",
        allowPausedReplay: true
      },
      async (a) => {
        await actor(a, input.actorUserId, input.actorAuthVersion, false);
        const scope = `supervisor:${input.actorUserId}`;
        const fingerprint = requestFingerprint("POST", "supervisor", input.sessionId ?? callId, {
          action: input.action,
          mode: input.mode ?? null
        });
        const previous = (
          await db.query("select * from call_operations where idempotency_scope=$1 and idempotency_key=$2", [
            scope,
            input.key
          ])
        ).rows[0];
        if (previous) {
          if (previous.request_fingerprint !== fingerprint)
            throw new SupervisorCoordinationError(
              "Request identity was already used for another supervisor action"
            );
          const s = (
            await db.query("select * from call_supervisor_sessions where id=$1", [
              previous.request.supervisorSessionId
            ])
          ).rows[0];
          return { session: snapshot(s), rootId: previous.id as string, replayed: true };
        }
        await actor(a, input.actorUserId, input.actorAuthVersion, input.action !== "stop");
        let s = (
          await db.query(
            input.action === "start"
              ? "select * from call_supervisor_sessions where actor_user_id=$1 and state in ('connecting','active')"
              : "select * from call_supervisor_sessions where actor_user_id=$1 and id=$2",
            input.action === "start" ? [input.actorUserId] : [input.actorUserId, input.sessionId]
          )
        ).rows[0];
        if (input.action === "start" && s) {
          if (s.call_id !== callId || s.coordination_protocol !== "native")
            throw new SupervisorCoordinationError(
              "Stop the current monitoring session before joining another call"
            );
          throw new SupervisorCoordinationError(
            "Monitoring is already active; retry the original request identity"
          );
        }
        if (input.action !== "start" && (!s || s.coordination_protocol !== "native"))
          throw new SupervisorCoordinationError("Supervisor session not found");
        if (
          s &&
          (
            await db.query(
              "select 1 from call_operations where request->>'supervisorSessionId'=$1 and resolved_at is null",
              [s.id]
            )
          ).rowCount
        )
          throw new SupervisorCoordinationError("Wait for the current monitoring action to finish");
        if (s && !["active", "connecting"].includes(s.state)) {
          throw new SupervisorCoordinationError(
            "Supervisor session is no longer active; retry the original request identity"
          );
        }
        if (input.action === "mode" && s.mode === input.mode)
          throw new SupervisorCoordinationError(
            "Monitoring is already in this mode; retry the original request identity"
          );
        if (a.startPaused && input.action !== "stop")
          throw new SupervisorCoordinationError("Call starts are paused for maintenance");
        const targets =
          input.action === "stop"
            ? { agent: s.target_agent_leg_uuid, customer: s.target_customer_leg_uuid }
            : await target(db, callId, input.actorUserId);
        if (
          s &&
          input.action === "mode" &&
          (targets.agent !== s.target_agent_leg_uuid || targets.customer !== s.target_customer_leg_uuid)
        )
          throw new SupervisorCoordinationError("Call media changed; stop monitoring before reconnecting");
        if (input.action !== "stop") {
          if (
            !input.endpoint ||
            !(
              await db.query(
                "select 1 from admin_supervisor_endpoints where user_id=$1 and sip_username=$2",
                [input.actorUserId, input.endpoint.sipUsername]
              )
            ).rowCount
          )
            throw new SupervisorCoordinationError("Supervisor phone is unavailable");
          supervisorEndpointRoute(input.endpoint.route);
        }
        const sessionId = s?.id ?? randomUUID(),
          rootId = randomUUID(),
          newLeg = randomUUID();
        const generation = String(BigInt(s?.generation ?? 0) + 1n);
        const requestedMode = input.action === "start" ? "listen" : (input.mode ?? s.mode);
        if (!s)
          s = (
            await db.query(
              `insert into call_supervisor_sessions(id,call_id,actor_user_id,mode,state,supervisor_leg_uuid,
        target_agent_leg_uuid,target_customer_leg_uuid,coordination_protocol) values($1,$2,$3,'listen','connecting',$4,$5,$6,'native') returning *`,
              [sessionId, callId, input.actorUserId, newLeg, targets.agent, targets.customer]
            )
          ).rows[0];
        const common = {
          supervisorSessionId: sessionId,
          supervisorAction: input.action,
          actorUserId: input.actorUserId,
          actorAuthVersion: input.actorAuthVersion,
          rootOperationId: rootId,
          endpoint: input.endpoint ?? null,
          mode: requestedMode,
          targetAgentUuid: targets.agent,
          targetCustomerUuid: targets.customer
        };
        async function enqueue(
          id: string,
          kind: "originate" | "hangup",
          leg: string,
          g: string,
          dependsOn: string | null
        ) {
          await enqueueCallCommand(a, {
            id,
            callId,
            scope: id === rootId ? scope : `supervisor-child:${rootId}`,
            key: id === rootId ? input.key : id,
            fingerprint,
            kind,
            generation: g,
            commandUuid: randomUUID(),
            targetUuid: leg,
            request: { ...common, dependsOn },
            deadline: (await db.query("select clock_timestamp()+interval '30 seconds' as at")).rows[0].at
          });
        }
        if (input.action !== "start")
          await enqueue(rootId, "hangup", s.supervisor_leg_uuid, s.generation, null);
        if (input.action !== "stop") {
          const id = input.action === "start" ? rootId : randomUUID();
          await enqueue(id, "originate", newLeg, generation, input.action === "mode" ? rootId : null);
          await db.query(
            `insert into supervisor_leg_evidence(supervisor_leg_uuid,session_id,call_id,generation,originate_operation_id) values($1,$2,$3,$4,$5)`,
            [newLeg, sessionId, callId, generation, id]
          );
        }
        await db.query(
          "update call_supervisor_sessions set control_root_id=$2,state='connecting',updated_at=clock_timestamp() where id=$1",
          [sessionId, rootId]
        );
        if (input.action === "start")
          await a.capacity.claim({
            kind: "supervisor",
            callId,
            operationId: rootId,
            generation: "1",
            supervisorSessionId: sessionId
          });
        s = (await db.query("select * from call_supervisor_sessions where id=$1", [sessionId])).rows[0];
        return { session: snapshot(s), rootId, replayed: false };
      }
    );
  } finally {
    db.release();
  }
}

// Append exact evidence, including obsolete legs. Projection waits for both job
// completion (one-frame sender quiescence) and channel evidence; an ACK is insufficient.
export async function persistSupervisorJob(db: pg.Pool | pg.PoolClient, job: BackgroundJobEvidence) {
  if (!uuid.test(job.jobUuid)) return false;
  const op = (
    await db.query(
      "select * from call_operations where command_uuid=$1 and request ? 'supervisorSessionId'",
      [job.jobUuid]
    )
  ).rows[0];
  if (!op) return false;
  await db.query(
    `insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,raw_json)
    values($1,'supervisor_command_job','BACKGROUND_JOB',$2,$3) on conflict do nothing`,
    [
      op.call_id,
      job.headers["event-uuid"] ?? null,
      { jobUuid: job.jobUuid, operationId: op.id, body: job.body.slice(0, 4096) }
    ]
  );
  return true;
}
export async function persistCoordinatedSupervisorEvent(
  pool: pg.Pool,
  input: { sessionId: string; supervisorLegUuid: string | null; eventName: string }
) {
  if (!input.supervisorLegUuid) return false;
  const row = (
    await pool.query(
      "select call_id from supervisor_leg_evidence where session_id=$1 and supervisor_leg_uuid=$2",
      [input.sessionId, input.supervisorLegUuid]
    )
  ).rows[0];
  if (!row) return false;
  const db = await pool.connect();
  try {
    await withCallAdmission(db, { callIds: [row.call_id] }, async () => {
      if (["CHANNEL_ANSWER", "CHANNEL_BRIDGE"].includes(input.eventName))
        await db.query(
          "update supervisor_leg_evidence set answered_at=coalesce(answered_at,clock_timestamp()) where supervisor_leg_uuid=$1 and ended_at is null",
          [input.supervisorLegUuid]
        );
      if (["CHANNEL_HANGUP_COMPLETE", "CHANNEL_DESTROY"].includes(input.eventName))
        await db.query(
          "update supervisor_leg_evidence set ended_at=clock_timestamp(),terminal_evidence=$2 where supervisor_leg_uuid=$1 and ended_at is null",
          [input.supervisorLegUuid, input.eventName]
        );
    });
  } finally {
    db.release();
  }
  await settleSupervisor(pool, row.call_id);
  return true;
}
export async function settleSupervisor(pool: pg.Pool, callId: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await settleSupervisorOnce(pool, callId);
    } catch (error) {
      if (!(error instanceof AdmissionDiscoveryChanged) || attempt >= 2) throw error;
    }
  }
}
async function settleSupervisorOnce(pool: pg.Pool, callId: string) {
  const db = await pool.connect();
  try {
    await withCallAdmission(db, { callIds: [callId] }, async (a) => {
      const sessions = (
        await db.query(
          "select * from call_supervisor_sessions where call_id=$1 and coordination_protocol='native' order by id",
          [callId]
        )
      ).rows;
      for (const s of sessions) {
        const ops = (
          await db.query(
            "select * from call_operations where request->>'supervisorSessionId'=$1 order by id",
            [s.id]
          )
        ).rows;
        // Canceled pending work was never sent; a rejected completed job has been
        // verified absent by the driver. Neither can create a future channel.
        for (const op of ops)
          if (["failed", "canceled"].includes(op.state) && op.command_kind === "originate")
            await db.query(
              "update supervisor_leg_evidence set ended_at=clock_timestamp(),terminal_evidence='resolved originate without a live channel' where originate_operation_id=$1 and ended_at is null",
              [op.id]
            );
        if (ops.some((o) => !o.resolved_at)) continue;
        const legs = (
          await db.query("select * from supervisor_leg_evidence where session_id=$1 order by generation", [
            s.id
          ])
        ).rows;
        const current = legs.find((l) => l.supervisor_leg_uuid === s.supervisor_leg_uuid);
        const live = legs.some((l) => !l.ended_at);
        if (!live) {
          await db.query(
            "update call_supervisor_sessions set state=$2,ended_at=coalesce(ended_at,clock_timestamp()),updated_at=clock_timestamp() where id=$1",
            [s.id, ops.some((o) => o.state === "failed") ? "failed" : "ended"]
          );
          const caps = (
            await db.query(
              "select * from call_capacity_reservations where supervisor_session_id=$1 and state<>'released' order by id",
              [s.id]
            )
          ).rows;
          for (const cap of caps)
            await a.capacity.releaseSupervisor(
              { id: cap.id, operationId: cap.operation_id, callId, generation: cap.generation },
              s.id
            );
        } else if (current?.answered_at && !current.ended_at) {
          await db.query(
            "update call_supervisor_sessions set state='active',connected_at=coalesce(connected_at,$2),updated_at=clock_timestamp() where id=$1",
            [s.id, current.answered_at]
          );
        }
      }
    });
  } finally {
    db.release();
  }
}

async function validate(op: DurableCommand, a: CallAdmission) {
  const db = a.client,
    r = op.request;
  const s = (
    await db.query("select * from call_supervisor_sessions where id=$1 and coordination_protocol='native'", [
      r.supervisorSessionId
    ])
  ).rows[0];
  if (!s || s.control_root_id !== r.rootOperationId || !["connecting", "active"].includes(s.state))
    return false;
  if (op.command_kind === "hangup")
    return s.supervisor_leg_uuid === op.target_uuid && s.generation === op.generation;
  try {
    await actor(a, r.actorUserId as string, r.actorAuthVersion as number, true);
    const t = await target(db, op.call_id, r.actorUserId as string);
    if (t.agent !== r.targetAgentUuid || t.customer !== r.targetCustomerUuid) return false;
    if (
      !(
        await db.query("select 1 from admin_supervisor_endpoints where user_id=$1 and sip_username=$2", [
          r.actorUserId,
          (r.endpoint as any).sipUsername
        ])
      ).rowCount
    )
      return false;
    if (
      r.dependsOn &&
      !(
        await db.query(
          "select 1 from supervisor_leg_evidence where supervisor_leg_uuid=$1 and ended_at is not null",
          [s.supervisor_leg_uuid]
        )
      ).rowCount
    )
      return false;
    if (
      !(
        await db.query(
          "select 1 from call_capacity_reservations where supervisor_session_id=$1 and state<>'released'",
          [s.id]
        )
      ).rowCount
    )
      return false;
    await db.query(
      "update call_supervisor_sessions set supervisor_leg_uuid=$2,generation=$3,mode=$4,originate_job_uuid=$5,connected_at=null,updated_at=clock_timestamp() where id=$1",
      [s.id, op.target_uuid, op.generation, r.mode, op.command_uuid]
    );
    return true;
  } catch (error) {
    if (error instanceof SupervisorCoordinationError) return false;
    throw error;
  }
}
export function supervisorCommand(config: AppConfig, op: DurableCommand) {
  if (
    !uuid.test(op.target_uuid ?? "") ||
    !uuid.test(op.call_id) ||
    !uuid.test(String(op.request.supervisorSessionId))
  )
    throw new Error("Invalid supervisor command identity");
  if (op.command_kind === "hangup") return `uuid_kill ${op.target_uuid} NORMAL_CLEARING`;
  if (op.command_kind !== "originate" || !uuid.test(String(op.request.targetAgentUuid)))
    throw new Error("Invalid supervisor command");
  const endpoint = op.request.endpoint as { sipUsername: string; route: string };
  if (!/^[A-Za-z0-9_-]+$/.test(endpoint.sipUsername)) throw new Error("Invalid supervisor SIP identity");
  return buildSupervisorEavesdropOriginateCommand(config, {
    callId: op.call_id,
    sessionId: String(op.request.supervisorSessionId),
    mode: op.request.mode as SupervisorMode,
    sipUsername: endpoint.sipUsername,
    supervisorLegUuid: op.target_uuid!,
    targetAgentLegUuid: String(op.request.targetAgentUuid)
  }).replace(
    `user/${endpoint.sipUsername}@${config.FREESWITCH_DOMAIN}`,
    supervisorEndpointRoute(endpoint.route)
  );
}
async function resolution(
  op: DurableCommand,
  db: pg.PoolClient,
  absent: (id: string, signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal
) {
  const job = (
    await db.query(
      "select raw_json from call_events where call_id=$1 and event_type='supervisor_command_job' and raw_json->>'jobUuid'=$2 order by created_at limit 1",
      [op.call_id, op.command_uuid]
    )
  ).rows[0]?.raw_json;
  if (!job || signal.aborted) return null;
  const leg = (
    await db.query("select * from supervisor_leg_evidence where supervisor_leg_uuid=$1", [op.target_uuid])
  ).rows[0];
  if (!leg) return null;
  const positive = String(job.body).trim().startsWith("+OK");
  if (op.command_kind === "originate" && positive && leg.answered_at)
    return {
      state: "succeeded" as const,
      result: { jobUuid: op.command_uuid },
      evidence: "fixed originate job completed and exact supervisor channel answered"
    };
  if (op.command_kind === "hangup" && leg.ended_at)
    return {
      state: "succeeded" as const,
      result: { jobUuid: op.command_uuid },
      evidence: "fixed hangup job completed and exact supervisor channel ended"
    };
  if (!positive && (await absent(op.target_uuid!, signal)) && !signal.aborted)
    return {
      state: "failed" as const,
      result: { jobUuid: op.command_uuid },
      evidence: "fixed job rejected; single sender completed and exact supervisor UUID absent"
    };
  return null;
}
export function supervisorExecutor(
  pool: pg.Pool,
  executor: CallExecutor,
  config: AppConfig,
  transport: { host: string; port: number; password: string },
  probe: (command: string, signal: AbortSignal) => Promise<string>
) {
  const driver = createCommandDriver({
    ...transport,
    buildCommand: (op) => supervisorCommand(config, op),
    validate,
    async verify(op, job, signal, db) {
      await persistSupervisorJob(db, job);
      while (!signal.aborted) {
        const result = await resolution(
          op,
          db,
          async (id, s) => (await probe(`uuid_exists ${id}`, s)).trim() === "false",
          signal
        );
        if (result) return result;
        await delay(20, undefined, { signal });
      }
      return null;
    },
    reconcile: (op, signal, db) =>
      resolution(op, db, async (id, s) => (await probe(`uuid_exists ${id}`, s)).trim() === "false", signal)
  });
  const send = driver.send.bind(driver);
  driver.send = async (op, signal, db) => {
    if (op.command_kind === "originate") {
      const endpoint = op.request.endpoint as { sipUsername: string; route: string };
      const contact = await probe(
        `sofia_contact internal-webrtc/${endpoint.sipUsername}@${config.FREESWITCH_DOMAIN}`,
        signal
      );
      const targets = await Promise.all([
        probe(`uuid_exists ${op.request.targetAgentUuid}`, signal),
        probe(`uuid_exists ${op.request.targetCustomerUuid}`, signal)
      ]);
      if (signal.aborted) return null;
      if (contact.trim() !== endpoint.route || targets.some((v) => v.trim() !== "true"))
        return {
          state: "failed",
          result: { notSent: true },
          evidence: "pre-send endpoint/target verification refused; no physical originate"
        };
    }
    return send(op, signal, db);
  };
  return {
    async wakeExecutor(rootId: string) {
      let op = (
        await pool.query("select * from call_operations where id=$1 and request ? 'supervisorSessionId'", [
          rootId
        ])
      ).rows[0] as DurableCommand | undefined;
      if (!op) throw new Error("Supervisor command not found");
      const callId = op.call_id;
      while (op) {
        const result = await executor.run(
          op.id,
          op.command_kind === "hangup" ? "critical" : "normal",
          driver
        );
        if (result.status !== "terminal") break;
        if (result.operation.state !== "succeeded") {
          const db = await pool.connect();
          try {
            await withCallAdmission(db, { callIds: [callId] }, async () => {
              await db.query(
                "update call_operations set state='canceled',resolved_at=clock_timestamp(),resolution_evidence='supervisor predecessor failed; never sent' where call_id=$1 and request->>'rootOperationId'=$2 and state='pending'",
                [callId, rootId]
              );
            });
          } finally {
            db.release();
          }
          break;
        }
        op = (
          await pool.query("select * from call_operations where call_id=$1 and request->>'dependsOn'=$2", [
            callId,
            op.id
          ])
        ).rows[0];
      }
      await settleSupervisor(pool, callId);
    }
  };
}
