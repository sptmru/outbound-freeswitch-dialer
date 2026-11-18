import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { withCallAdmission, type CallAdmission } from "./call-admission.js";
import { CapacityError } from "./call-capacity.js";
import { enqueueCallCommand, type CallExecutor, type DurableCommand } from "./call-executor.js";
import { createCommandDriver, type BackgroundJobEvidence } from "./call-command-transport.js";
import { requestFingerprint } from "./call-coordination-contracts.js";
import { normalizePhoneNumber } from "./dashboard/phone.js";
import { reconcileCoordinatedCallCleanup } from "./call-cleanup.js";
import { reconcileIngress } from "./inbound-ingress.js";
import { ingressRequest, type IngressCommand } from "./ingress-agent.js";
import { ingressUuid } from "./ingress-journal.js";
import { parseFreeSwitchEventTimestamp } from "./call-observability.js";

const safePath = /^\/[A-Za-z0-9_./-]+$/;
const terminalEvents = ["CHANNEL_HANGUP", "CHANNEL_HANGUP_COMPLETE", "CHANNEL_DESTROY", "INGRESS_ABSENT"];
const cleanEvents = ["CHANNEL_HANGUP_COMPLETE", "CHANNEL_DESTROY", "INGRESS_ABSENT"];

/** SQL-only admission; the imported immutable ingress identity is the authority.
 * No agent slot or outbound contact lifecycle is claimed by ring-all admission.
 */
export async function admitInboundQueue(
  pool: pg.Pool,
  callId: string,
  checkpoint?: (admission: CallAdmission) => Promise<void>
): Promise<DurableCommand | null> {
  const db = await pool.connect();
  try {
    const campaign = (await db.query("select campaign_id from calls where id=$1", [callId])).rows[0]
      ?.campaign_id;
    return await withCallAdmission(
      db,
      { callIds: [callId], startsCall: true, audioCampaignIds: campaign ? [campaign] : [] },
      async (a) => {
        const call = (await db.query("select * from calls where id=$1", [callId])).rows[0];
        assert.equal(call?.direction, "inbound");
        const old = (
          await db.query("select operation_id from inbound_queue_admissions where call_id=$1", [callId])
        ).rows[0];
        if (old)
          return (await db.query("select * from call_operations where id=$1", [old.operation_id])).rows[0];
        if (call.ended_at || call.state !== "received") return null;
        const e = (await db.query("select * from inbound_ingress_evidence where call_id=$1", [callId]))
          .rows[0];
        assert.ok(e && !e.terminal_at && e.route_snapshot, "Captured ingress required");
        const snapshot = e.route_snapshot;
        assert.equal(snapshot.queueId, call.inbound_queue_id);
        assert.equal(snapshot.campaignId, call.campaign_id);
        const remaining = (
          await db.query("select queue_deadline_at>clock_timestamp() as live from calls where id=$1", [
            callId
          ])
        ).rows[0].live;
        if (!remaining) {
          await db.query(
            "update calls set state='failed',outcome='failed',ended_at=clock_timestamp(),queue_exited_at=clock_timestamp(),inbound_end_reason='queue_deadline_before_admission' where id=$1",
            [callId]
          );
          return null;
        }
        const config = snapshot.configuration;
        let audio = "tone";
        if (config.waiting_audio_id) {
          const recording = (
            await db.query(
              "select runtime_file_path from recordings where id=$1 and campaign_id=$2 and is_active for key share",
              [config.waiting_audio_id, call.campaign_id]
            )
          ).rows[0];
          assert.ok(
            recording &&
              safePath.test(recording.runtime_file_path) &&
              !recording.runtime_file_path.split("/").includes(".."),
            "Waiting audio unavailable"
          );
          audio = recording.runtime_file_path;
        }
        const caller = normalizePhoneNumber(call.calling_number);
        const contact = caller.ok
          ? (
              await db.query(
                "select id from contacts where campaign_id=$1 and normalized_phone_number=$2 order by id limit 1",
                [call.campaign_id, caller.number]
              )
            ).rows[0]?.id
          : null;
        await db.query(
          "update calls set state='queued',inbound_context_contact_id=$2,updated_at=clock_timestamp() where id=$1",
          [callId, contact ?? null]
        );
        // A savepoint permits a durable explicit overflow result without partial
        // participants/operations/claims. All other failures roll back admission.
        await db.query("savepoint queue_claim");
        try {
          const participant = (
            await db.query(
              "insert into call_participants(call_id,role,external_number,joined_at) values($1,'customer',$2,$3) returning id",
              [callId, call.calling_number, call.arrived_at]
            )
          ).rows[0].id;
          const leg = (
            await db.query(
              "insert into call_legs(call_id,participant_id,type,freeswitch_uuid,state,started_at) values($1::uuid,$2,'customer',$1::text,'started',$3) returning id",
              [callId, participant, call.arrived_at]
            )
          ).rows[0].id;
          const id = randomUUID();
          const deadline = (
            await db.query(
              "select least(queue_deadline_at,clock_timestamp()+interval '3 seconds') as deadline,floor(extract(epoch from queue_deadline_at))::bigint::text as epoch from calls where id=$1",
              [callId]
            )
          ).rows[0];
          const flow = (
            await db.query(
              "select flow_timeout_ms from inbound_flow_versions where id::text=$1 and campaign_id=$2",
              [config.no_answer_flow_version_id ?? null, call.campaign_id]
            )
          ).rows[0];
          const request = {
            fallbackGuardSeconds: flow ? Math.ceil(flow.flow_timeout_ms / 1000) + 3 : 0,
            inboundWaiting: true,
            participantId: participant,
            legId: leg,
            route: snapshot,
            audio,
            deadlineEpoch: deadline.epoch
          };
          const { operation } = await enqueueCallCommand(a, {
            id,
            callId,
            scope: `inbound-queue:${callId}`,
            key: "admission",
            fingerprint: requestFingerprint("POST", "internal/inbound-queue", callId, request),
            kind: "play_audio",
            generation: "1",
            commandUuid: randomUUID(),
            targetUuid: callId,
            request,
            deadline: deadline.deadline
          });
          await a.capacity.claim({
            kind: "inbound",
            callId,
            operationId: id,
            generation: "1",
            callLegId: leg
          });
          await db.query(
            "insert into inbound_queue_admissions(call_id,operation_id,waiting_audio_id) values($1,$2,$3)",
            [callId, id, config.waiting_audio_id ?? null]
          );
          await db.query(
            "insert into call_events(call_id,event_type,state,customer_leg_uuid,raw_json) values($1::uuid,'inbound_queue_admitted','queued',$1::text,$2)",
            [callId, { operationId: id, route: snapshot }]
          );
          await checkpoint?.(a);
          return operation;
        } catch (error) {
          if (!(error instanceof CapacityError) || error.reason !== "capacity_exceeded") throw error;
          await db.query("rollback to savepoint queue_claim");
          await db.query(
            "update calls set state='failed',outcome='failed',ended_at=clock_timestamp(),queue_exited_at=clock_timestamp(),inbound_end_reason='capacity_exceeded' where id=$1",
            [callId]
          );
          await db.query(
            "insert into call_events(call_id,event_type,state,raw_json) values($1,'inbound_admission_rejected','failed',$2)",
            [callId, { reason: error.reason, resource: error.resource }]
          );
          return null;
        }
      }
    );
  } finally {
    db.release();
  }
}

/** Internal dispatcher/context reader. Ordering is PostgreSQL microseconds, not JS Dates. */
export async function readInboundQueue(db: pg.Pool | pg.PoolClient, campaignId: string) {
  return (
    await db.query(
      `select c.id,c.campaign_id,c.arrived_at,c.queue_deadline_at,c.inbound_context_contact_id,
    c.calling_number,e.route_snapshot from calls c join inbound_queue_admissions a on a.call_id=c.id
    join inbound_ingress_evidence e on e.call_id=c.id
    where c.campaign_id=$1 and c.state='queued' and c.ended_at is null
      and c.queue_exited_at is null and c.fallback_started_at is null and c.queue_deadline_at>clock_timestamp()
    order by c.arrived_at,c.id`,
      [campaignId]
    )
  ).rows;
}

export async function persistInboundQueueJob(db: pg.Pool | pg.PoolClient, job: BackgroundJobEvidence) {
  if (!ingressUuid.test(job.jobUuid)) return false;
  const op = (
    await db.query(
      "select * from call_operations where command_uuid=$1 and request->>'inboundWaiting'='true'",
      [job.jobUuid]
    )
  ).rows[0];
  if (!op) return false;
  await db.query(
    "insert into call_events(call_id,event_type,freeswitch_event_name,freeswitch_event_uuid,raw_json) values($1,'inbound_wait_job','BACKGROUND_JOB',$2,$3) on conflict do nothing",
    [op.call_id, job.headers["event-uuid"] ?? null, { jobUuid: job.jobUuid, body: job.body.slice(0, 4096) }]
  );
  return true;
}

/** Trusted ESL only. The customer UUID is the durable ingress UUID. Agent
 * connection additionally requires E02's persisted winner, slot and bridge intent.
 */
export async function persistInboundQueueEvent(
  pool: pg.Pool,
  headers: Record<string, string>,
  body = "",
  recovered = false
): Promise<boolean> {
  const callId =
    headers["variable_outbound_dialer_ingress_uuid"] ??
    headers["outbound-dialer-call-id"] ??
    headers["variable_outbound_dialer_call_id"];
  if (!ingressUuid.test(callId ?? "")) return false;
  const known = (await pool.query("select 1 from inbound_ingress_evidence where call_id=$1", [callId]))
    .rowCount;
  if (!known) return false;
  const uuid = headers["unique-id"] ?? headers["outbound-dialer-customer-leg-uuid"];
  const event = headers["event-name"];
  const db = await pool.connect();
  try {
    await withCallAdmission(db, { callIds: [callId] }, async (a) => {
      const call = (await db.query("select * from calls where id=$1", [callId])).rows[0];
      const leg = (
        await db.query(
          "select l.*,p.role from call_legs l join call_participants p on p.id=l.participant_id where l.call_id=$1 and l.freeswitch_uuid=$2",
          [callId, uuid]
        )
      ).rows[0];
      if (uuid !== callId && !leg) return;
      if (event === "INGRESS_ABSENT" && !recovered) return;
      // The bounded journal also returns acknowledged terminal snapshots. They
      // must not append a new synthetic absence fact on every recovery pass.
      if (event === "INGRESS_ABSENT" && call.ended_at && leg?.ended_at) return;
      const customer = uuid === callId;
      const clean = cleanEvents.includes(event);
      const at = parseFreeSwitchEventTimestamp(headers) ?? new Date();
      const ended = terminalEvents.includes(event);
      const waiting =
        event === "CUSTOM" && headers["event-subclass"] === "outbound_dialer::inbound_waiting_started";
      if (waiting) {
        const fixed = (
          await db.query(
            "select 1 from inbound_queue_admissions a join call_operations o on o.id=a.operation_id where a.call_id=$1 and o.id=$2 and o.target_uuid=$3",
            [callId, headers["outbound-dialer-operation-id"], uuid]
          )
        ).rowCount;
        if (!fixed || !customer) return;
      }
      await db.query(
        `insert into call_events(call_id,event_type,state,freeswitch_event_name,freeswitch_event_uuid,customer_leg_uuid,agent_leg_uuid,raw_json)
        values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
        [
          callId,
          waiting ? "inbound_waiting_started" : `inbound_${event.toLowerCase()}`,
          call.state,
          event,
          headers["event-uuid"] ?? null,
          customer ? uuid : null,
          customer ? null : uuid,
          { headers, body }
        ]
      );
      if (clean && leg) {
        await db.query(
          "update call_legs set state='ended',ended_at=coalesce(ended_at,greatest(started_at,$2)) where id=$1",
          [leg.id, at]
        );
        await db.query(
          "update call_participants set left_at=coalesce(left_at,greatest(joined_at,$2)),end_reason=coalesce(end_reason,$3) where id=$1",
          [leg.participant_id, at, headers["hangup-cause"] ?? event]
        );
      }
      if (!call.ended_at) {
        if (!customer && leg && event === "CHANNEL_ANSWER")
          await db.query(
            "update call_legs set state='answered',answered_at=coalesce(answered_at,$2) where id=$1 and ended_at is null",
            [leg.id, at]
          );
        if (customer && (event === "CHANNEL_ANSWER" || waiting)) {
          await db.query(
            "update calls set pstn_answered_at=coalesce(pstn_answered_at,greatest(arrived_at,$2)),answered_at=coalesce(answered_at,greatest(arrived_at,$2)) where id=$1",
            [callId, at]
          );
          if (leg)
            await db.query(
              "update call_legs set state='answered',answered_at=coalesce(answered_at,$2) where id=$1 and ended_at is null",
              [leg.id, at]
            );
        }
        if (event === "CHANNEL_BRIDGE" && call.fallback_started_at) {
          await db.query(
            `update call_participants p set connected_at=coalesce(connected_at,greatest(joined_at,$4))
            from call_legs l,call_operations o where p.id=l.participant_id and p.call_id=$1 and p.role='external'
            and o.call_id=p.call_id and o.command_kind='forward_external' and o.request->>'legId'=l.id::text
            and exists(select 1 from call_execution_attempts where operation_id=o.id)
            and (($2::text=$1::text and l.freeswitch_uuid=$3) or ($3::text=$1::text and l.freeswitch_uuid=$2))
            and p.left_at is null and l.ended_at is null`,
            [callId, uuid, headers["other-leg-unique-id"] ?? null, at]
          );
        }
        if (event === "CHANNEL_BRIDGE" && call.state === "connecting") {
          const peer = headers["other-leg-unique-id"];
          const winner = (
            await db.query(
              `select p.id,p.agent_id,p.slot_reservation_id,p.slot_generation from call_participants p join call_legs l on l.participant_id=p.id
            join agent_call_slots s on s.participant_id=p.id and s.call_id=p.call_id and s.agent_id=p.agent_id
              and s.reservation_id=p.slot_reservation_id and s.generation=p.slot_generation
            join call_offers o on o.call_id=p.call_id and o.agent_id=p.agent_id and o.state='accepted'
            where p.call_id=$1 and p.agent_id=$4 and p.role='agent' and p.left_at is null and l.ended_at is null
              and s.state in ('connecting','active') and not s.reconciliation_required
              and (($2::text=$1::text and l.freeswitch_uuid=$3::text) or (l.freeswitch_uuid=$2::text and $3::text=$1::text))
              and exists(select 1 from call_operations x join call_execution_attempts t on t.operation_id=x.id
                where x.call_id=$1 and x.command_kind='bridge' and x.state in ('uncertain','succeeded')
                  and x.request->>'participantId'=p.id::text
                  and (not exists(select 1 from inbound_connection_attempts where call_id=$1)
                    or exists(select 1 from inbound_connection_attempts i where i.call_id=$1 and i.participant_id=p.id
                      and i.bridge_operation_id=x.id and i.settled_at is null)))`,
              [callId, uuid, peer ?? null, call.agent_id]
            )
          ).rows[0];
          if (winner) {
            await db.query(
              "update calls set state='agent_connected',agent_id=$2,agent_connected_at=greatest(arrived_at,coalesce(pstn_answered_at,arrived_at),$3),queue_exited_at=coalesce(queue_exited_at,$3) where id=$1",
              [callId, winner.agent_id, at]
            );
            await db.query(
              "update call_participants set connected_at=coalesce(connected_at,greatest(joined_at,$2)) where id=$1",
              [winner.id, at]
            );
            await a.transition(
              {
                agentId: winner.agent_id,
                callId,
                reservationId: winner.slot_reservation_id,
                generation: winner.slot_generation
              },
              "active"
            );
          }
        }
        if (customer && ended) {
          const admitted = Boolean(
            (await db.query("select 1 from inbound_queue_admissions where call_id=$1", [callId])).rowCount
          );
          const canceled = headers["hangup-cause"] === "ORIGINATOR_CANCEL";
          const fallbackHangup = call.fallback_started_at
            ? (
                await db.query(
                  `select o.request->>'reason' as reason from call_operations o join call_execution_attempts a on a.operation_id=o.id where o.call_id=$1 and o.command_kind='hangup' and o.request->>'inboundFallback'='true' order by o.created_at desc limit 1`,
                  [callId]
                )
              ).rows[0]
            : null;
          const external = (
            await db.query(
              "select connected_at,left_at from call_participants where call_id=$1 and role='external' order by created_at limit 1",
              [callId]
            )
          ).rows[0];
          const transferFailure = (
            await db.query(
              `select 1 from call_operations o join call_execution_attempts a on a.operation_id=o.id
            where o.call_id=$1 and o.target_uuid::text=$2 and o.request->>'transferOfferAcceptance'='true'
              and o.request->>'transferAction'='cleanup_customer' limit 1`,
              [callId, uuid]
            )
          ).rowCount;
          const reason =
            event === "INGRESS_ABSENT"
              ? "channel_absent_on_recovery"
              : transferFailure
                ? "transfer_switch_failed"
                : external?.connected_at
                  ? "external_forward_completed"
                  : external && !external.left_at
                    ? "caller_hung_up_during_forwarding"
                    : fallbackHangup
                      ? `no_answer_${fallbackHangup.reason}`
                      : call.fallback_started_at
                        ? headers["hangup-cause"] === "ALLOTTED_TIMEOUT"
                          ? "no_answer_deadline"
                          : "caller_hung_up_during_fallback"
                        : headers["hangup-cause"] === "ALLOTTED_TIMEOUT" && !call.agent_connected_at
                          ? "queue_timeout"
                          : call.agent_connected_at
                            ? "customer_hung_up"
                            : admitted
                              ? canceled
                                ? "caller_canceled_in_queue"
                                : "caller_abandoned_queue"
                              : canceled
                                ? "caller_canceled_before_admission"
                                : "caller_hung_up_before_admission";
          await db.query(
            "update calls set state=$2,outcome=case when $4 in ('transfer_switch_failed','channel_absent_on_recovery') then 'failed' when $4='external_forward_completed' then 'answered' when $4='queue_timeout' or $4 like 'no_answer_%' then 'not_answered' else 'customer_hung_up' end,ended_at=greatest(arrived_at,$3),queue_exited_at=coalesce(queue_exited_at,greatest(arrived_at,$3)),inbound_end_reason=$4,terminal_event_name=$5,terminal_source=case when $4='channel_absent_on_recovery' then 'lifecycle_recovery' else 'inbound_customer' end,updated_at=clock_timestamp() where id=$1",
            [
              callId,
              event === "INGRESS_ABSENT" || transferFailure ? "failed" : canceled ? "canceled" : "completed",
              at,
              reason,
              event
            ]
          );
        }
      }
      if (ended && customer)
        await db.query(
          `update call_operations set state='canceled',resolved_at=clock_timestamp(),resolution_evidence='customer terminal before waiting sender started'
        where call_id=$1 and request->>'inboundWaiting'='true' and state='pending'
        and not exists(select 1 from call_execution_attempts where operation_id=call_operations.id)`,
          [callId]
        );
    });
  } finally {
    db.release();
  }
  if (terminalEvents.includes(event)) await reconcileCoordinatedCallCleanup(pool, callId);
  return true;
}

export function inboundWaitingCommand(op: DurableCommand) {
  assert.ok(
    op.request.inboundWaiting &&
      ingressUuid.test(op.id) &&
      ingressUuid.test(op.target_uuid ?? "") &&
      op.target_uuid === op.call_id
  );
  assert.match(op.request.deadlineEpoch as string, /^[1-9][0-9]{9,11}$/);
  assert.ok(
    Number.isInteger(op.request.fallbackGuardSeconds ?? 0) &&
      Number(op.request.fallbackGuardSeconds ?? 0) >= 0 &&
      Number(op.request.fallbackGuardSeconds ?? 0) <= 183
  );
  const audio = op.request.audio as string;
  assert.ok(audio === "tone" || (safePath.test(audio) && !audio.split("/").includes("..")));
  return `uuid_transfer ${op.target_uuid} inbound_wait:${op.id}:${op.request.deadlineEpoch}:${audio}:${op.request.fallbackGuardSeconds ?? 0} XML inbound-wait`;
}
async function waitingResolution(op: DurableCommand, db: pg.PoolClient) {
  const job = (
    await db.query(
      "select raw_json from call_events where call_id=$1 and event_type='inbound_wait_job' and raw_json->>'jobUuid'=$2 limit 1",
      [op.call_id, op.command_uuid]
    )
  ).rows[0]?.raw_json;
  if (!job) return null;
  if (!String(job.body).trim().startsWith("+OK"))
    return {
      state: "failed" as const,
      result: { jobUuid: op.command_uuid },
      evidence: "fixed waiting job rejected; single sender complete"
    };
  const effect = (
    await db.query(
      `select 1 from call_events where call_id=$1 and
    ((event_type='inbound_waiting_started' and raw_json->'headers'->>'outbound-dialer-operation-id'=$2)
      or (customer_leg_uuid=$1::text and freeswitch_event_name in ('CHANNEL_HANGUP_COMPLETE','CHANNEL_DESTROY','INGRESS_ABSENT'))) limit 1`,
      [op.call_id, op.id]
    )
  ).rowCount;
  return effect
    ? {
        state: "succeeded" as const,
        result: { jobUuid: op.command_uuid },
        evidence: "fixed waiting job complete; exact waiting/terminal effect persisted"
      }
    : null;
}

async function cleanupIfNeeded(pool: pg.Pool, callId: string) {
  const needed = (
    await pool.query(
      `select 1 from calls c where c.id=$1 and
    (c.ended_at is not null or exists(select 1 from call_participants p where p.call_id=c.id and p.left_at is not null))`,
      [callId]
    )
  ).rowCount;
  if (needed) await reconcileCoordinatedCallCleanup(pool, callId);
}

/** Explicit staged dependency; server.ts does not bootstrap a native C03 worker.
 * The coordinator creates no executor/pool/role and never weakens I05's marker.
 */
export function createInboundQueueCoordinator(
  pool: pg.Pool,
  socket: string,
  command: IngressCommand,
  executor: CallExecutor,
  esl: { host: string; port: number; password: string },
  checkpoint?: (point: "before-insert" | "after-commit", uuid?: string) => Promise<void>
) {
  const driver = createCommandDriver({
    ...esl,
    buildCommand: inboundWaitingCommand,
    async validate(op, a) {
      return (
        (
          await a.client.query(
            `select 1 from inbound_queue_admissions x join calls c on c.id=x.call_id
        join call_legs l on l.id=$3 where x.operation_id=$1 and x.call_id=$2 and c.state='queued'
        and c.ended_at is null and c.queue_deadline_at>clock_timestamp() and l.call_id=c.id
        and l.freeswitch_uuid=c.id::text and l.ended_at is null`,
            [op.id, op.call_id, op.request.legId]
          )
        ).rowCount === 1
      );
    },
    async verify(op, job, signal, db) {
      await persistInboundQueueJob(db, job);
      while (!signal.aborted) {
        const result = await waitingResolution(op, db);
        if (result) return result;
        await delay(20, undefined, { signal });
      }
      return null;
    },
    async reconcile(op, _signal, db) {
      return waitingResolution(op, db);
    }
  });
  return {
    async reconcile() {
      const status = await reconcileIngress(pool, socket, command, checkpoint, {
        async beforeImport(row) {
          if (row.terminalUs !== null)
            await persistInboundQueueEvent(
              pool,
              {
                variable_outbound_dialer_ingress_uuid: row.uuid,
                "unique-id": row.uuid,
                "event-name": "INGRESS_ABSENT",
                "event-date-timestamp": String(row.terminalUs)
              },
              "",
              true
            );
        },
        async afterImport(row) {
          if (row.terminalUs !== null) return;
          const ended = (await pool.query("select ended_at from calls where id=$1", [row.uuid])).rows[0]
            ?.ended_at;
          if (ended) return;
          const op = await admitInboundQueue(pool, row.uuid);
          if (!op || ["failed", "canceled"].includes(op.state)) return;
          await ingressRequest(socket, "/admit", { uuid: row.uuid, operationId: op.id });
          await executor.run(op.id, "normal", driver);
          await cleanupIfNeeded(pool, row.uuid);
        }
      });
      // Journal terminal ACK/recycling cannot strand a late fixed job. Inspect
      // bounded SQL work even when its receipt is no longer in the local spool.
      const unresolved = (
        await pool.query(`select id,call_id from call_operations
        where request->>'inboundWaiting'='true' and resolved_at is null
        order by deadline_at,id limit 8`)
      ).rows;
      for (const op of unresolved) {
        await executor.run(op.id, "normal", driver);
        await cleanupIfNeeded(pool, op.call_id);
      }
      return status;
    }
  };
}
