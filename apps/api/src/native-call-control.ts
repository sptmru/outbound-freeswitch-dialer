import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import type { CallControlResponse, DeskMutationRequest } from "@outbound-dialer/shared";
import { withCallAdmission, type CallAdmission } from "./call-admission.js";
import { idempotencyScope, requestFingerprint } from "./call-coordination-contracts.js";
import { enqueueCallCommand, type DurableCommand, type CallExecutor } from "./call-executor.js";
import { createCommandDriver, type BackgroundJobEvidence } from "./call-command-transport.js";
import { reconcileCoordinatedCallCleanup } from "./call-cleanup.js";
import type { SlotToken } from "./agent-call-slots.js";
import { resolveAgentEndOutcome } from "./call-outcomes.js";

export class CallControlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
type Action = "end" | "drop-voicemail" | "dtmf";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A server-owned absolute recording path must fit one literal dialplan destination.
const path = /^\/[A-Za-z0-9_./-]+$/;

/** SQL only. The actual route authenticates/CSRF-checks before entering here.
 * Replay precedes mutable call/Desk checks; it never grants another send.
 */
export async function admitNativeCallControl(
  pool: pg.Pool,
  input: {
    callId: string;
    actorUserId: string;
    actorAuthVersion: number;
    action: Action;
    intent: DeskMutationRequest;
    digit?: string;
    audit?: Record<string, unknown>;
  }
): Promise<CallControlResponse & { replayed: boolean }> {
  const client = await pool.connect();
  try {
    const campaignId = (await client.query("select campaign_id from calls where id=$1", [input.callId]))
      .rows[0]?.campaign_id;
    return await withCallAdmission(
      client,
      {
        callIds: [input.callId],
        userIds: [input.actorUserId],
        audioCampaignIds: input.action === "drop-voicemail" && campaignId ? [campaignId] : []
      },
      async (a) => {
        const user = (
          await client.query("select is_active,auth_version from users where id=$1", [input.actorUserId])
        ).rows[0];
        if (!user?.is_active || user.auth_version !== input.actorAuthVersion)
          throw new CallControlError("not_controller");
        const route = `/agent/calls/:callId/${input.action}`;
        const scope = idempotencyScope(input.actorUserId, "POST", route, input.callId);
        const fingerprint = requestFingerprint("POST", route, input.callId, {
          intent: input.intent,
          ...(input.action === "dtmf" ? { digit: input.digit } : {})
        });
        const old = (
          await client.query(
            "select * from call_operations where idempotency_scope=$1 and idempotency_key=$2",
            [scope, input.intent.idempotencyKey]
          )
        ).rows[0];
        if (old) {
          if (old.request_fingerprint !== fingerprint) throw new CallControlError("idempotency_conflict");
          return { ...old.request.response, replayed: true };
        }
        const call = (await client.query("select * from calls where id=$1", [input.callId])).rows[0];
        const owner = (
          await client.query(
            `select s.*,d.revision,d.binding_generation,d.verified_generation,
        d.revoked_at,(d.expires_at>clock_timestamp()) as lease_live,d.verified_endpoint from agents a
        join agent_call_slots s on s.agent_id=a.id
        join agent_desk_sessions d on d.id=$3 and d.agent_id=a.id
        where a.user_id=$1 and a.id=$2`,
            [input.actorUserId, call?.agent_id, input.intent.deskSessionId]
          )
        ).rows[0];
        if (!call || !owner || owner.revoked_at || !owner.lease_live)
          throw new CallControlError("not_controller");
        if (call.campaign_id !== campaignId) throw new CallControlError("revision_conflict");
        if (
          owner.revision !== input.intent.expectedRevision ||
          owner.binding_generation !== input.intent.bindingGeneration
        )
          throw new CallControlError("revision_conflict");
        if (owner.verified_generation !== owner.binding_generation || !owner.verified_endpoint)
          throw new CallControlError("endpoint_unavailable");
        if (
          call.ended_at ||
          owner.call_id !== input.callId ||
          owner.state === "free" ||
          owner.reconciliation_required
        )
          throw new CallControlError("not_owner");
        if (
          (
            await client.query("select 1 from call_operations where call_id=$1 and resolved_at is null", [
              input.callId
            ])
          ).rowCount
        )
          throw new CallControlError("call_outcome_uncertain");
        if (
          (
            await client.query("select 1 from call_transfers where call_id=$1 and closed_at is null", [
              input.callId
            ])
          ).rowCount
        )
          throw new CallControlError("transfer_in_progress");
        const legs = (
          await client.query(
            `select l.*,p.role,p.slot_reservation_id,p.slot_generation from call_legs l
        join call_participants p on p.id=l.participant_id and p.call_id=l.call_id
        where l.call_id=$1 and l.ended_at is null and p.left_at is null and
        (p.role='customer' or (p.id=$2 and p.role='agent' and p.agent_id=$3)) order by p.role`,
            [input.callId, owner.participant_id, call.agent_id]
          )
        ).rows;
        const agent = legs.find((l) => l.role === "agent"),
          customer = legs.find((l) => l.role === "customer");
        if (
          !agent ||
          legs.filter((l) => l.role === "customer").length > 1 ||
          agent.slot_reservation_id !== owner.reservation_id ||
          agent.slot_generation !== owner.generation ||
          !uuid.test(agent.freeswitch_uuid) ||
          legs.some((l) => !uuid.test(l.freeswitch_uuid))
        )
          throw new CallControlError("not_owner");
        const slot: SlotToken = {
          agentId: call.agent_id,
          callId: input.callId,
          reservationId: owner.reservation_id,
          generation: owner.generation
        };
        if (
          input.action === "dtmf" &&
          (!/^[0-9*#]$/.test(input.digit ?? "") ||
            !customer ||
            !["bridged", "agent_connected", "voicemail_signal_detected"].includes(call.state))
        )
          throw new CallControlError("not_owner");
        let recording: { id: string; runtime_file_path: string } | undefined;
        if (input.action === "drop-voicemail") {
          if (!customer || !["bridged", "voicemail_signal_detected", "agent_connected"].includes(call.state))
            throw new CallControlError("voicemail_unavailable");
          recording = (
            await client.query(
              `select r.id,r.runtime_file_path from campaigns c join recordings r on r.id=c.voicemail_recording_id
          and r.campaign_id=c.id and r.is_active where c.id=$1 for key share of r`,
              [call.campaign_id]
            )
          ).rows[0];
          if (
            !recording ||
            !path.test(recording.runtime_file_path) ||
            recording.runtime_file_path.split("/").includes("..")
          )
            throw new CallControlError("voicemail_unavailable");
        }
        const operationId = randomUUID();
        const response: CallControlResponse = {
          status: "accepted",
          callId: input.callId,
          operationId,
          revision: owner.revision
        };
        const targets =
          input.action === "dtmf"
            ? [customer!]
            : input.action === "drop-voicemail"
              ? [customer!, agent]
              : [...legs.filter((l) => l.role === "customer"), agent];
        let previous: string | null = null;
        for (const [i, leg] of targets.entries()) {
          const id = i === 0 ? operationId : randomUUID();
          await enqueueCallCommand(a, {
            id,
            callId: input.callId,
            scope: i === 0 ? scope : `native-control-child:${operationId}`,
            key: i === 0 ? input.intent.idempotencyKey : id,
            fingerprint,
            kind:
              input.action === "dtmf"
                ? "send_dtmf"
                : recording && i === 0
                  ? "play_audio"
                  : input.action === "end"
                    ? "hangup"
                    : "release_agent",
            generation: slot.generation,
            commandUuid: randomUUID(),
            targetUuid: leg.freeswitch_uuid,
            request: {
              controlAction: input.action,
              digit: input.digit,
              endOutcome: input.action === "end" ? resolveAgentEndOutcome(call.state) : null,
              rootOperationId: operationId,
              dependsOn: previous,
              slot,
              participantId: leg.participant_id,
              actorUserId: input.actorUserId,
              actorAuthVersion: user.auth_version,
              recordingPath: recording?.runtime_file_path,
              recordingId: recording?.id,
              response
            },
            deadline: (await client.query("select clock_timestamp()+interval '30 seconds' as deadline"))
              .rows[0].deadline
          });
          previous = id;
        }
        if (recording)
          await client.query(
            `update calls set state='voicemail_drop_requested',recording_id=$2,
        voicemail_drop_requested_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1`,
            [input.callId, recording.id]
          );
        if (input.action !== "dtmf") await a.transition(slot, "releasing");
        await client.query(
          `insert into call_events(call_id,agent_id,event_type,state,raw_json)
        values($1,$2,$3,$4,$5) on conflict(call_id,event_type) where event_type in (
          'voicemail_drop_requested','voicemail_playback_started','agent_released',
          'voicemail_playback_completed','voicemail_playback_interrupted')
        do update set raw_json=excluded.raw_json,created_at=clock_timestamp()`,
          [
            input.callId,
            call.agent_id,
            input.action === "dtmf"
              ? "native_dtmf_requested"
              : recording
                ? "voicemail_drop_requested"
                : "native_call_end_requested",
            recording ? "voicemail_drop_requested" : call.state,
            { operationId, audit: input.audit ?? null, recordingId: recording?.id }
          ]
        );
        // The lifecycle request event is unique per call; retain every distinct
        // retry-key admission separately, including a fresh request after rejection.
        await client.query(
          `insert into call_events(call_id,agent_id,event_type,state,raw_json)
          values($1,$2,'native_call_control_admitted',$3,$4)`,
          [
            input.callId,
            call.agent_id,
            recording ? "voicemail_drop_requested" : call.state,
            { operationId, action: input.action }
          ]
        );
        return { ...response, replayed: false };
      }
    );
  } finally {
    client.release();
  }
}

/** Append trusted BACKGROUND_JOB evidence even if the command socket lost its ACK.
 * A completed fixed job proves this single-frame sender has no future command.
 * Missing jobs never turn a missing-channel observation into sender quiescence.
 */
export async function persistNativeCommandJob(
  db: pg.Pool | pg.PoolClient,
  job: BackgroundJobEvidence
): Promise<boolean> {
  if (!uuid.test(job.jobUuid)) return false;
  const op = (
    await db.query("select * from call_operations where command_uuid=$1 and request ? 'controlAction'", [
      job.jobUuid
    ])
  ).rows[0];
  if (!op) return false;
  await db.query(
    `insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,raw_json)
    values($1,'native_command_job','BACKGROUND_JOB',$2,$3) on conflict do nothing`,
    [
      op.call_id,
      job.headers["event-uuid"] ?? null,
      { operationId: op.id, jobUuid: job.jobUuid, body: job.body.slice(0, 4096) }
    ]
  );
  return true;
}

async function validate(operation: DurableCommand, admission: CallAdmission): Promise<boolean> {
  const r = operation.request,
    token = r.slot as SlotToken | undefined;
  if (!token || token.callId !== operation.call_id || token.generation !== operation.generation) return false;
  const found = await admission.client.query(
    `select 1 from call_legs l
    join call_participants p on p.id=l.participant_id and p.call_id=l.call_id
    join agent_call_slots s on s.agent_id=$4 join calls c on c.id=l.call_id
    where l.call_id=$1 and l.freeswitch_uuid=$2 and p.id=$3 and c.agent_id=$4
      and s.call_id=c.id and s.reservation_id=$5 and s.generation=$6 and s.state<>'free'
      and not s.reconciliation_required
      and exists(select 1 from call_participants a where a.call_id=c.id and a.agent_id=$4
        and a.slot_reservation_id=$5 and a.slot_generation=$6)
      and ($7<>'play_audio' or (c.ended_at is null and c.recording_id=$8))
      and ($7<>'send_dtmf' or (c.ended_at is null and c.state in ('bridged','agent_connected','voicemail_signal_detected')
        and not exists(select 1 from call_transfers t where t.call_id=c.id and t.closed_at is null)))`,
    [
      operation.call_id,
      operation.target_uuid,
      r.participantId,
      token.agentId,
      token.reservationId,
      token.generation,
      operation.command_kind,
      r.recordingId ?? null
    ]
  );
  return found.rowCount === 1;
}

export function nativeControlCommand(operation: DurableCommand): string {
  if (!uuid.test(operation.target_uuid ?? "") || !uuid.test(operation.call_id))
    throw new Error("Invalid control UUID");
  if (operation.command_kind === "send_dtmf") {
    if (!/^[0-9*#]$/.test(String(operation.request.digit))) throw new Error("Invalid DTMF digit");
    return `uuid_send_dtmf ${operation.target_uuid} ${operation.request.digit}`;
  }
  if (operation.command_kind === "play_audio") {
    const file = operation.request.recordingPath;
    if (typeof file !== "string" || !path.test(file) || file.split("/").includes(".."))
      throw new Error("Invalid recording path");
    return `uuid_transfer ${operation.target_uuid} voicemail_native:${operation.call_id}:${file} XML default`;
  }
  if (!["hangup", "release_agent"].includes(operation.command_kind))
    throw new Error("Unsupported native control");
  return `uuid_kill ${operation.target_uuid} NORMAL_CLEARING`;
}

async function resolveJob(operation: DurableCommand, db: pg.PoolClient) {
  const job = (
    await db.query(
      `select raw_json from call_events where call_id=$1 and event_type='native_command_job'
    and raw_json->>'jobUuid'=$2 order by created_at limit 1`,
      [operation.call_id, operation.command_uuid]
    )
  ).rows[0]?.raw_json;
  if (!job) return null;
  const positive = String(job.body).trim().startsWith("+OK");
  if (operation.command_kind === "send_dtmf")
    return {
      state: positive ? ("succeeded" as const) : ("failed" as const),
      result: { jobUuid: operation.command_uuid },
      evidence: "fixed DTMF job completed; no far-end reception claim"
    };
  const effect =
    operation.command_kind === "play_audio"
      ? (
          await db.query(
            `select 1 from call_events where call_id=$1 and customer_leg_uuid=$2
        and event_type in ('voicemail_playback_started','voicemail_playback_completed','voicemail_playback_failed')`,
            [operation.call_id, operation.target_uuid]
          )
        ).rowCount
      : (
          await db.query(
            `select 1 from call_legs where call_id=$1 and freeswitch_uuid=$2 and participant_id=$3 and ended_at is not null`,
            [operation.call_id, operation.target_uuid, operation.request.participantId]
          )
        ).rowCount;
  if (effect)
    return {
      state: "succeeded" as const,
      result: { jobUuid: operation.command_uuid },
      evidence: "fixed BACKGROUND_JOB completed; exact persisted channel effect"
    };
  if (!positive)
    return {
      state: "failed" as const,
      result: { jobUuid: operation.command_uuid },
      evidence: "fixed BACKGROUND_JOB rejected command; single sender complete"
    };
  return null;
}

/** Installed explicitly by staged bootstrap/tests. Global enablement belongs to I05.
 * Every run can resume a persisted chain; HTTP replay never creates/sends new work.
 */
export function nativeCallControlExecutor(
  pool: pg.Pool,
  executor: CallExecutor,
  esl: { host: string; port: number; password: string }
) {
  const driver = createCommandDriver({
    ...esl,
    buildCommand: nativeControlCommand,
    validate,
    async verify(op, job, signal, db) {
      await persistNativeCommandJob(db, job);
      while (!signal.aborted) {
        const result = await resolveJob(op, db);
        if (result) return result;
        await delay(25, undefined, { signal });
      }
      return null;
    },
    async reconcile(op, _signal, db) {
      return resolveJob(op, db);
    }
  });
  return {
    async wakeExecutor(rootId: string) {
      const root = (
        await pool.query(
          "select * from call_operations where id=$1 and request->>'rootOperationId'=$1::text",
          [rootId]
        )
      ).rows[0];
      if (!root) throw new Error("Native control root not found");
      // Follow explicit parent identities; timestamp/UUID ordering is not sequencing.
      let current: DurableCommand | undefined = root;
      while (current) {
        const result = await executor.run(
          current.id,
          ["play_audio", "send_dtmf"].includes(current.command_kind) ? "normal" : "critical",
          driver
        );
        if (result.status !== "terminal") break;
        const child = (
          await pool.query("select * from call_operations where call_id=$1 and request->>'dependsOn'=$2", [
            root.call_id,
            current.id
          ])
        ).rows[0];
        if (result.operation.state !== "succeeded") {
          const client = await pool.connect();
          try {
            await withCallAdmission(client, { callIds: [root.call_id] }, async (a) => {
              await a.client.query(
                `update call_operations set state='canceled',resolved_at=clock_timestamp(),
            resolution_evidence='control predecessor did not succeed; child never sent'
            where call_id=$1 and request->>'rootOperationId'=$2 and state='pending'`,
                [root.call_id, rootId]
              );
              // A rejected, never-effective voicemail claim remains an interactive call.
              await a.client.query(
                `update calls set state='bridged',voicemail_drop_requested_at=null where id=$1
            and state='voicemail_drop_requested' and ended_at is null and exists(
              select 1 from call_events where call_id=$1 and event_type='voicemail_drop_requested'
                and raw_json->>'operationId'=$2) and not exists(
              select 1 from call_events where call_id=$1 and event_type='voicemail_playback_started')`,
                [root.call_id, rootId]
              );
            });
          } finally {
            client.release();
          }
          break;
        }
        current = child;
      }
      await reconcileCoordinatedCallCleanup(pool, root.call_id);
    }
  };
}
