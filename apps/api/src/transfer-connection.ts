import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { updateAgentCallSlot, type SlotToken } from "./agent-call-slots.js";
import { AdmissionDiscoveryChanged, withCallAdmission, type CallAdmission } from "./call-admission.js";
import {
  enqueueCallCommand,
  type CallExecutor,
  type DurableCommand,
  type CommandResolution
} from "./call-executor.js";
import { createCommandDriver, type BackgroundJobEvidence } from "./call-command-transport.js";
import { reconcileCoordinatedCallCleanup } from "./call-cleanup.js";
import { ingressUuid } from "./ingress-journal.js";
import { serviceInviteCommand } from "./service-invite-command.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import type { AppConfig } from "./config.js";

const steps = ["prepare_customer", "prepare_source", "originate", "park", "bridge"] as const;
const action = (o: DurableCommand) => String(o.request.transferAction ?? "originate");
const rootId = (o: DurableCommand) => String(o.request.transferRootId ?? o.id);
const terminal = (o: DurableCommand) => ["succeeded", "failed", "canceled"].includes(o.state);
const cleanup = (o: DurableCommand) => action(o).startsWith("cleanup_");
const scope = (id: string) => `transfer-execution:${id}`;

export function transferConnectionCommand(op: DurableCommand) {
  const r = op.request;
  assert.equal(r.transferOfferAcceptance, true);
  for (const id of [op.call_id, op.target_uuid, r.agentUuid, r.sourceUuid, r.customerUuid, r.transferId])
    assert.ok(typeof id === "string" && ingressUuid.test(id));
  switch (action(op)) {
    case "prepare_customer":
    case "prepare_source":
      return `uuid_setvar_multi ${op.target_uuid} hangup_after_bridge=false;park_after_bridge=true;park_timeout=;outbound_dialer_transfer_id=${r.transferId}`;
    case "restore_customer":
    case "restore_source":
    case "restore_recipient":
      return `uuid_setvar_multi ${op.target_uuid} hangup_after_bridge=true;park_after_bridge=false;park_timeout=`;
    case "originate":
      return serviceInviteCommand(op, [
        "hangup_after_bridge=false",
        "park_after_bridge=true",
        `outbound_dialer_transfer_id=${r.transferId}`
      ]);
    case "park":
      return `uuid_park ${r.customerUuid}`;
    case "bridge":
      return `uuid_bridge ${r.customerUuid} ${r.agentUuid}`;
    case "cleanup_source":
    case "cleanup_recipient":
    case "cleanup_customer":
      return `uuid_kill ${op.target_uuid} NORMAL_CLEARING`;
    default:
      throw new Error("Unsupported transfer connection action");
  }
}

/** Extend the immutable G01 intent with immutable children; no schema/request
 * rewrite, and no send occurs here. The root validator requires both preparations.
 */
export async function prepareTransferCommands(pool: pg.Pool, id: string) {
  return inAdmission(pool, id, async (a, root, t) => {
    if (t.closed_at) return;
    let predecessor: string | undefined;
    for (const step of steps) {
      if (step === "originate") {
        predecessor = root.id;
        continue;
      }
      const child = await enqueue(a, root, step, predecessor, root.deadline_at);
      predecessor = child.id;
    }
  });
}
async function enqueue(
  a: CallAdmission,
  root: DurableCommand,
  step: string,
  dependsOn?: string,
  deadline?: Date
) {
  const r = root.request;
  const target = step.endsWith("source")
    ? r.sourceUuid
    : step.endsWith("recipient")
      ? r.agentUuid
      : r.customerUuid;
  return (
    await enqueueCallCommand(a, {
      id: randomUUID(),
      callId: root.call_id,
      scope: scope(root.id),
      key: step,
      fingerprint: "0".repeat(64),
      kind: step.startsWith("cleanup_") ? "hangup" : "rebridge",
      generation: root.generation,
      commandUuid: randomUUID(),
      targetUuid: String(target),
      request: { ...r, transferRootId: root.id, transferAction: step, dependsOn: dependsOn ?? null },
      deadline:
        deadline ?? (await a.client.query("select clock_timestamp()+interval '30 seconds' as at")).rows[0].at
    })
  ).operation;
}
async function inAdmission<T>(
  pool: pg.Pool,
  id: string,
  fn: (a: CallAdmission, root: DurableCommand, t: pg.QueryResultRow) => Promise<T>
) {
  const root = (
    await pool.query(
      "select * from call_operations where id=$1 and request->>'transferOfferAcceptance'='true'",
      [id]
    )
  ).rows[0] as DurableCommand | undefined;
  if (!root || root.request.transferRootId) throw new Error("Transfer root not found");
  const db = await pool.connect();
  try {
    for (let retry = 0; retry < 3; retry++) {
      try {
        return await withCallAdmission(db, { callIds: [root.call_id] }, async (a) => {
          const t = (
            await db.query("select * from call_transfers where operation_id=$1 and id=$2", [
              id,
              root.request.transferId
            ])
          ).rows[0];
          if (!t) throw new Error("Transfer intent mismatch");
          return fn(a, root, t);
        });
      } catch (error) {
        if (!(error instanceof AdmissionDiscoveryChanged) || retry === 2) throw error;
      }
    }
  } finally {
    db.release();
  }
}
async function operations(db: pg.Pool | pg.PoolClient, root: DurableCommand) {
  return (
    await db.query(
      "select * from call_operations where id=$1 or idempotency_scope=$2 order by created_at,id",
      [root.id, scope(root.id)]
    )
  ).rows as DurableCommand[];
}

export async function validateTransferConnection(op: DurableCommand, a: CallAdmission) {
  const r = op.request,
    s = r.slot as SlotToken;
  if (!s || s.callId !== op.call_id || s.generation !== op.generation) return false;
  const legs = (
    await a.client.query("select * from call_legs where call_id=$1 and freeswitch_uuid=any($2::text[])", [
      op.call_id,
      [r.sourceUuid, r.agentUuid, r.customerUuid]
    ])
  ).rows;
  const target = legs.find((l) => l.freeswitch_uuid === op.target_uuid);
  if (!target) return false;
  if (cleanup(op)) return true; // Exact immutable UUID only; late cleanup cannot target a newer slot.
  if (action(op).startsWith("restore_"))
    return (
      Boolean(
        (
          await a.client.query(
            "select 1 from calls c join call_transfers t on t.call_id=c.id where c.id=$1 and c.ended_at is null and t.operation_id=$2 and t.closed_at is null and c.agent_id in (t.source_agent_id,t.recipient_agent_id)",
            [op.call_id, rootId(op)]
          )
        ).rowCount
      ) && !target.ended_at
    );
  const row = (
    await a.client.query(
      `select c.*,t.state transfer_state,t.closed_at,
    p.left_at recipient_left,l.ended_at recipient_ended,d.verified_at>clock_timestamp()-interval '15 seconds' recent
    from call_transfers t join calls c on c.id=t.call_id
    join call_participants p on p.id=$3 and p.call_id=c.id and p.agent_id=t.recipient_agent_id
    join call_legs l on l.participant_id=p.id and l.freeswitch_uuid=$4
    join agent_call_slots s on s.agent_id=p.agent_id and s.participant_id=p.id and s.call_id=c.id
    join agent_desk_sessions d on d.id=$5 and d.agent_id=p.agent_id
    join agents ag on ag.id=p.agent_id join users u on u.id=ag.user_id
    where t.id=$1 and t.operation_id=$2 and t.closed_at is null and c.ended_at is null
      and s.reservation_id=$6 and s.generation=$7 and s.state in ('connecting','active','uncertain')
      and not s.reconciliation_required and p.slot_reservation_id=s.reservation_id and p.slot_generation=s.generation
      and d.revoked_at is null and d.expires_at>clock_timestamp() and d.ready
      and d.revision=$8 and d.binding_generation=$9 and d.verified_generation=d.binding_generation
      and d.verified_endpoint=$10 and d.endpoint_pin=d.verified_endpoint and d.sip_username=$11
      and u.id=$12 and u.is_active and u.auth_version=$13 and d.actor_auth_version=u.auth_version`,
      [
        r.transferId,
        rootId(op),
        r.participantId,
        r.agentUuid,
        (r.intent as Record<string, string>).deskSessionId,
        s.reservationId,
        s.generation,
        (r.intent as Record<string, string>).expectedRevision,
        (r.intent as Record<string, string>).bindingGeneration,
        r.endpoint,
        r.sipUsername,
        r.actorUserId,
        r.actorAuthVersion
      ]
    )
  ).rows[0];
  if (
    !row ||
    row.recipient_left ||
    row.recipient_ended ||
    legs.find((l) => l.freeswitch_uuid === r.customerUuid)?.ended_at
  )
    return false;
  // Supervision is separately implemented in G04. Refuse a switch while a live
  // supervisor could silently follow the customer or whisper to another owner.
  if (
    (
      await a.client.query(
        "select 1 from call_supervisor_sessions where call_id=$1 and state in ('connecting','active')",
        [op.call_id]
      )
    ).rowCount
  )
    return false;
  if (row.agent_id !== r.sourceAgentId) return false;
  const source = (
    await a.client.query(
      `select 1 from agent_call_slots s join call_participants p on p.id=s.participant_id
    where s.agent_id=$1 and s.call_id=$2 and s.reservation_id=$3 and s.generation=$4
      and p.id=$5 and p.slot_generation=s.generation and p.slot_reservation_id=s.reservation_id`,
      [
        r.sourceAgentId,
        op.call_id,
        (r.sourceSlot as SlotToken).reservationId,
        (r.sourceSlot as SlotToken).generation,
        r.sourceParticipantId
      ]
    )
  ).rowCount;
  if (!source) return false;
  if (action(op) === "originate") {
    if (!row.recent) return false;
    const ready = (
      await a.client.query(
        "select count(*)::int n from call_operations where idempotency_scope=$1 and idempotency_key in ('prepare_customer','prepare_source') and state='succeeded'",
        [scope(op.id)]
      )
    ).rows[0].n;
    return ready === 2;
  }
  if (action(op) === "park") {
    if (legs.find((l) => l.freeswitch_uuid === r.sourceUuid)?.ended_at) return false;
    // Persist the switch boundary before its first possible physical send.
    await a.client.query("update call_transfers set state='switching' where id=$1 and closed_at is null", [
      r.transferId
    ]);
  }
  return true;
}

export async function persistTransferJob(db: pg.Pool | pg.PoolClient, job: BackgroundJobEvidence) {
  if (!ingressUuid.test(job.jobUuid)) return false;
  const op = (
    await db.query(
      "select id,call_id from call_operations where command_uuid=$1 and request->>'transferOfferAcceptance'='true'",
      [job.jobUuid]
    )
  ).rows[0];
  if (!op) return false;
  await db.query(
    "insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,raw_json) values($1,'transfer_command_job','BACKGROUND_JOB',$2,$3) on conflict do nothing",
    [
      op.call_id,
      job.headers["event-uuid"] ?? null,
      { operationId: op.id, jobUuid: job.jobUuid, body: job.body.slice(0, 4096) }
    ]
  );
  return true;
}

/** Trusted ESL facts are associated only with an already attempted exact step.
 * No bridge event alone changes product ownership, especially after termination.
 */
export async function persistTransferEvent(pool: pg.Pool, headers: Record<string, string>) {
  const name = headers["event-name"],
    uuid = headers["unique-id"],
    peer = headers["other-leg-unique-id"];
  if (!["CHANNEL_PARK", "CHANNEL_BRIDGE"].includes(name) || !ingressUuid.test(uuid ?? "")) return;
  const rows = (
    await pool.query(
      `select o.id,o.call_id from call_operations o join call_transfers t on t.id=(o.request->>'transferId')::uuid
    join calls c on c.id=o.call_id
    where o.request->>'transferOfferAcceptance'='true' and o.request->>'transferId'=$4 and t.closed_at is null and c.ended_at is null
      and exists(select 1 from call_execution_attempts x where x.operation_id=o.id)
      and (($1='CHANNEL_PARK' and o.target_uuid::text=$2 and coalesce(o.request->>'transferAction','originate') in ('originate','park'))
        or ($1='CHANNEL_BRIDGE' and o.request->>'transferAction'='bridge'
          and (($2=o.request->>'customerUuid' and $3=o.request->>'agentUuid') or ($3=o.request->>'customerUuid' and $2=o.request->>'agentUuid'))))`,
      [name, uuid, peer ?? null, headers["variable_outbound_dialer_transfer_id"] ?? null]
    )
  ).rows;
  for (const row of rows)
    await pool.query(
      "insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,raw_json) values($1,'transfer_command_effect',$2,$3,$4) on conflict do nothing",
      [row.call_id, name, headers["event-uuid"] ?? null, { operationId: row.id, headers }]
    );
}

/** A fixed completed single-send job is required before any absence probe can
 * settle work. Missing job, response loss or elapsed deadline stays uncertain.
 */
export async function resolveTransferCommand(
  op: DurableCommand,
  db: pg.PoolClient,
  probe: (command: string) => Promise<string>,
  signal: AbortSignal
): Promise<CommandResolution | null> {
  const job = (
    await db.query(
      "select raw_json from call_events where call_id=$1 and event_type='transfer_command_job' and raw_json->>'jobUuid'=$2 order by created_at limit 1",
      [op.call_id, op.command_uuid]
    )
  ).rows[0]?.raw_json;
  if (!job || signal.aborted) return null;
  const positive = String(job.body).trim().startsWith("+OK");
  const exists = await probe(`uuid_exists ${op.target_uuid}`);
  if (signal.aborted || !["true", "false"].includes(exists)) return null;
  const effect = (
    await db.query(
      "select 1 from call_events where call_id=$1 and event_type='transfer_command_effect' and raw_json->>'operationId'=$2",
      [op.call_id, op.id]
    )
  ).rowCount;
  let state: CommandResolution["state"] | undefined;
  if (cleanup(op)) {
    if (exists === "false") {
      await withCallAdmission(db, { callIds: [op.call_id] }, async () => {
        await db.query(
          "update call_legs set state='ended',ended_at=coalesce(ended_at,clock_timestamp()) where call_id=$1 and freeswitch_uuid=$2",
          [op.call_id, op.target_uuid]
        );
        await db.query(
          "update call_participants set left_at=coalesce(left_at,clock_timestamp()),end_reason=coalesce(end_reason,'transfer_cleanup') where id in (select participant_id from call_legs where call_id=$1 and freeswitch_uuid=$2)",
          [op.call_id, op.target_uuid]
        );
      });
      state = "succeeded";
    }
  } else if (exists === "false" || !positive) state = "failed";
  else if (action(op).startsWith("prepare_")) {
    const hangup = await probe(`uuid_getvar ${op.target_uuid} hangup_after_bridge`),
      park = await probe(`uuid_getvar ${op.target_uuid} park_after_bridge`);
    if (hangup === "false" && park === "true") state = "succeeded";
  } else if (action(op).startsWith("restore_")) {
    if (
      (await probe(`uuid_getvar ${op.target_uuid} hangup_after_bridge`)) === "true" &&
      (await probe(`uuid_getvar ${op.target_uuid} park_after_bridge`)) === "false"
    )
      state = "succeeded";
  } else if (action(op) === "bridge") {
    if (
      effect &&
      (await probe(`uuid_getvar ${op.request.customerUuid} bridge_uuid`)) === op.request.agentUuid
    )
      state = "succeeded";
  } else if (effect) state = "succeeded";
  return state && !signal.aborted
    ? {
        state,
        result: { jobUuid: op.command_uuid },
        evidence: "fixed completed transfer job and exact channel effect"
      }
    : null;
}

/** SQL progression after each independently fenced C03 step. Uncertain work is
 * never canceled/replaced. Switching failures terminate truthfully; no promise
 * to restore a missing source. All cleanup uses fixed UUIDs and critical seats.
 */
export async function settleTransferConnection(pool: pg.Pool, id: string) {
  return inAdmission(pool, id, async (a, root, t) => {
    const db = a.client,
      ops = await operations(db, root);
    if (t.closed_at) {
      const sourceClean = (
        await db.query("select ended_at from call_legs where call_id=$1 and freeswitch_uuid=$2", [
          root.call_id,
          root.request.sourceUuid
        ])
      ).rows[0]?.ended_at;
      if (t.state === "completed" && sourceClean) await releaseOverlap();
      const ended = (await db.query("select ended_at from calls where id=$1", [root.call_id])).rows[0]
        ?.ended_at;
      if (ended && !ops.some((o) => !terminal(o) && o.state !== "pending")) {
        for (const step of ["cleanup_source", "cleanup_recipient", "cleanup_customer"]) {
          if (!ops.some((o) => action(o) === step)) {
            await enqueue(a, root, step);
            break;
          }
        }
      }
      return;
    }
    if (ops.some((o) => !terminal(o) && o.state !== "pending")) {
      await db.query("update call_transfers set state='uncertain' where id=$1", [t.id]);
      return;
    }
    const c = (await db.query("select * from calls where id=$1", [root.call_id])).rows[0];
    const r = root.request;
    const bridged = ops.find((o) => action(o) === "bridge" && o.state === "succeeded");
    const sourceLeg = (
      await db.query("select * from call_legs where call_id=$1 and freeswitch_uuid=$2", [
        root.call_id,
        r.sourceUuid
      ])
    ).rows[0];
    const recipientLeg = (
      await db.query("select * from call_legs where call_id=$1 and freeswitch_uuid=$2", [
        root.call_id,
        r.agentUuid
      ])
    ).rows[0];
    if (bridged && !c.ended_at && !recipientLeg.ended_at) {
      const confirmed = (
        await db.query(
          "select 1 from call_events where call_id=$1 and event_type='transfer_handover' and raw_json->>'transferId'=$2",
          [root.call_id, t.id]
        )
      ).rowCount;
      if (!confirmed) {
        await db.query(
          "update calls set agent_id=$2,agent_released_at=null,updated_at=clock_timestamp() where id=$1 and agent_id=$3 and ended_at is null",
          [root.call_id, t.recipient_agent_id, t.source_agent_id]
        );
        await db.query(
          "update call_participants set connected_at=coalesce(connected_at,clock_timestamp()) where id=$1 and left_at is null",
          [r.participantId]
        );
        await db.query(
          "update call_participants set left_at=coalesce(left_at,clock_timestamp()),end_reason=coalesce(end_reason,'transferred') where id=$1",
          [r.sourceParticipantId]
        );
        await db.query(
          "insert into call_events(call_id,agent_id,event_type,raw_json) values($1,$2,'transfer_handover',$3)",
          [root.call_id, t.recipient_agent_id, { transferId: t.id, operationId: bridged.id }]
        );
      }
      // The fixed bridge job/effect has resolved the connection uncertainty.
      // Ordinary admission transitions deliberately cannot assert this evidence.
      await updateAgentCallSlot(db, r.slot as SlotToken, "active");
      await db.query("update call_transfers set state='switching' where id=$1", [t.id]);
      const old = ops.find((o) => action(o) === "cleanup_source");
      if (!old) {
        await enqueue(a, root, "cleanup_source");
        return;
      }
      if (!terminal(old) || !sourceLeg.ended_at) return;
      if (old.state !== "succeeded") return; // Retain unresolved physical cleanup for operator recovery.
      if (!(await restored(["restore_customer", "restore_recipient"]))) return;
      await close("completed", "bridge_and_source_cleanup_confirmed");
      await releaseOverlap();
      return;
    }
    const failed =
      c.ended_at ||
      recipientLeg.ended_at ||
      sourceLeg.ended_at ||
      ops.some((o) => !cleanup(o) && ["failed", "canceled"].includes(o.state));
    if (!failed) return;
    await db.query(
      "update call_operations set state='canceled',resolved_at=clock_timestamp(),resolution_evidence='transfer failure before this sender started' where (id=$1 or idempotency_scope=$2) and state='pending' and coalesce(request->>'transferAction','originate') not like 'cleanup_%' and coalesce(request->>'transferAction','originate') not like 'restore_%'",
      [root.id, scope(root.id)]
    );
    const switching = ops.some(
      (o) => ["park", "bridge"].includes(action(o)) && o.state !== "pending" && o.state !== "canceled"
    );
    const terminate = switching || Boolean(sourceLeg.ended_at);
    const targets = [
      "cleanup_recipient",
      ...(terminate || c.ended_at ? ["cleanup_source", "cleanup_customer"] : [])
    ];
    for (const step of targets) {
      const old = ops.find((o) => action(o) === step);
      if (!old) {
        await enqueue(a, root, step);
        return;
      }
      if (old.state !== "succeeded") return;
    }
    if (terminate && !c.ended_at)
      await db.query(
        "update calls set state='failed',outcome='failed',ended_at=clock_timestamp(),inbound_end_reason=case when direction='inbound' then 'transfer_switch_failed' else inbound_end_reason end,updated_at=clock_timestamp() where id=$1 and ended_at is null and manual_status_locked_at is null",
        [root.call_id]
      );
    if (!terminate && !c.ended_at && !(await restored(["restore_customer", "restore_source"]))) return;
    if (!switching && !c.ended_at && !sourceLeg.ended_at)
      await updateAgentCallSlot(db, r.sourceSlot as SlotToken, "active");
    await close(
      c.ended_at && c.outcome !== "failed" && !bridged ? "canceled" : "failed",
      c.ended_at
        ? c.outcome === "failed"
          ? "transfer_switch_failed"
          : "customer_ended"
        : terminate
          ? "transfer_switch_failed"
          : "recipient_connection_failed"
    );
    await releaseOverlap();
    async function restored(keys: string[]) {
      for (const step of keys) {
        const old = ops.find((o) => action(o) === step);
        if (!old) {
          await enqueue(a, root, step);
          return false;
        }
        if (old.state !== "succeeded") return false;
      }
      return true;
    }
    async function close(state: string, reason: string) {
      await db.query(
        "update call_transfers set state=$2,reason=$3,closed_at=clock_timestamp() where id=$1 and closed_at is null",
        [t.id, state, reason]
      );
    }
    async function releaseOverlap() {
      for (const v of (
        await db.query(
          "select * from call_capacity_reservations where operation_id=$1 and resource_type='transfer_overlap' and state<>'released'",
          [root.id]
        )
      ).rows)
        await a.capacity.release(
          { id: v.id, operationId: root.id, callId: root.call_id, generation: v.generation },
          true
        );
    }
  });
}

export function transferConnectionDriver(esl: { host: string; port: number; password: string }) {
  const probe = async (command: string) =>
    (
      await sendFreeSwitchApiCommand(
        {
          FREESWITCH_ESL_HOST: esl.host,
          FREESWITCH_ESL_PORT: esl.port,
          FREESWITCH_ESL_PASSWORD: esl.password
        } as AppConfig,
        command,
        1000
      )
    ).body.trim();
  return createCommandDriver({
    ...esl,
    buildCommand: transferConnectionCommand,
    validate: validateTransferConnection,
    async verify(op, job, signal, db) {
      await persistTransferJob(db, job);
      while (!signal.aborted) {
        const result = await resolveTransferCommand(op, db, probe, signal);
        if (result) return result;
        await delay(20, undefined, { signal });
      }
      return null;
    },
    reconcile: (op, signal, db) => resolveTransferCommand(op, db, probe, signal)
  });
}
export function transferConnectionExecutor(
  pool: pg.Pool,
  executor: CallExecutor,
  esl: { host: string; port: number; password: string }
) {
  const driver = transferConnectionDriver(esl);
  async function runStep(op: DurableCommand) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        return await executor.run(op.id, cleanup(op) ? "critical" : "normal", driver);
      } catch (error) {
        if (!(error instanceof AdmissionDiscoveryChanged) || retry === 2) throw error;
      }
    }
    throw new Error("Transfer execution discovery exhausted");
  }
  return {
    async wakeExecutor(id: string) {
      await prepareTransferCommands(pool, id);
      const root = (await pool.query("select * from call_operations where id=$1", [id]))
        .rows[0] as DurableCommand;
      // Bounded progression; each step has at most one physical send. Concurrent
      // wakes share C03's per-call lock, immutable step scope and dependencies.
      for (let i = 0; i < 12; i++) {
        const t = (await pool.query("select * from call_transfers where operation_id=$1", [id])).rows[0];
        const ended = (await pool.query("select ended_at from calls where id=$1", [root.call_id])).rows[0]
          ?.ended_at;
        if (t.closed_at && !ended) {
          await settleTransferConnection(pool, id);
          break;
        }
        if (t.closed_at) await settleTransferConnection(pool, id);
        let ops = await operations(pool, root);
        const uncertain = ops.find((o) => !terminal(o) && o.state !== "pending");
        const next =
          uncertain ??
          ops.find((o) => cleanup(o) && o.state === "pending") ??
          ops.find((o) => action(o).startsWith("restore_") && o.state === "pending") ??
          steps.map((step) => ops.find((o) => action(o) === step)).find((o) => o?.state === "pending");
        if (next) {
          const result = await runStep(next);
          if (result.status !== "terminal") {
            await settleTransferConnection(pool, id);
            break;
          }
        }
        await settleTransferConnection(pool, id);
        ops = await operations(pool, root);
        if (!next && !ops.some((o) => o.state === "pending")) break;
      }
      for (let retry = 0; retry < 3; retry++) {
        try {
          await reconcileCoordinatedCallCleanup(pool, root.call_id);
          break;
        } catch (error) {
          if (!(error instanceof AdmissionDiscoveryChanged) || retry === 2) throw error;
        }
      }
    },
    async reconcile() {
      for (const t of (
        await pool.query(
          `select t.operation_id from call_transfers t join calls c on c.id=t.call_id
            where t.operation_id is not null and (t.closed_at is null
              or exists(select 1 from call_capacity_reservations v where v.operation_id=t.operation_id and v.resource_type='transfer_overlap' and v.state<>'released')
              or (c.ended_at is not null and
              (exists(select 1 from call_legs l where l.call_id=c.id and l.ended_at is null)
                or exists(select 1 from call_operations o where o.call_id=c.id and o.resolved_at is null))))
            order by t.deadline_at,t.id limit 8`
        )
      ).rows)
        await this.wakeExecutor(t.operation_id);
    }
  };
}
