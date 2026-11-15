import type pg from "pg";
import type { CallOutcome } from "@outbound-dialer/shared";
import { resolveCustomerHangupOutcome } from "./call-outcomes.js";
import { withCallAdmission, type CallAdmission } from "./call-admission.js";
import { finishAgentCall } from "./agent-availability.js";

type Queryable = pg.Pool | pg.PoolClient;
// Native histories must never fall through a legacy role-wide UPDATE/uuid_exists
// repair. This also fences incomplete native work before a participant exists.
export async function isCoordinatedCall(db: Queryable, callId: string): Promise<boolean> {
  return Boolean(
    (
      await db.query(
        `select (c.direction='inbound' or exists(select 1 from call_participants p where p.call_id=c.id and p.origin='native')
      or exists(select 1 from call_operations o where o.call_id=c.id)) as coordinated from calls c where c.id=$1`,
        [callId]
      )
    ).rows[0]?.coordinated
  );
}

export interface ConcreteCallEvent {
  callId: string;
  legUuid: string | null;
  eventName: string;
  eventUuid: string | null;
  eventAt?: Date | null;
  hangupCause?: string;
  playback?: "started" | "completed" | "failed";
  raw?: Record<string, unknown>;
}
const terminal = (state: string) => ["completed", "failed", "canceled"].includes(state);

/** Trusted ESL adapter only. Correlation is looked up by the immutable concrete
 * UUID, never by role or a client-supplied owner. No command is issued here.
 * HANGUP establishes customer termination; COMPLETE/DESTROY establishes cleanup.
 * Neither event establishes that an unresolved sender has stopped.
 */
export async function persistCoordinatedCallEvent(pool: pg.Pool, input: ConcreteCallEvent): Promise<boolean> {
  if (!(await isCoordinatedCall(pool, input.callId))) return false;
  const client = await pool.connect();
  try {
    await withCallAdmission(client, { callIds: [input.callId] }, async (admission) => {
      const call = (await client.query("select * from calls where id=$1", [input.callId])).rows[0];
      const leg = (
        await client.query(
          `select l.*,p.agent_id,p.left_at from call_legs l
        join call_participants p on p.id=l.participant_id and p.call_id=l.call_id
        where l.call_id=$1 and l.freeswitch_uuid=$2`,
          [input.callId, input.legUuid]
        )
      ).rows[0];
      // Unknown/mismatched UUIDs cannot change state or invent a participation.
      if (!call || !leg) return;
      const ended = ["CHANNEL_HANGUP", "CHANNEL_HANGUP_COMPLETE", "CHANNEL_DESTROY"].includes(
        input.eventName
      );
      const clean = ["CHANNEL_HANGUP_COMPLETE", "CHANNEL_DESTROY"].includes(input.eventName);
      await client.query(
        `insert into call_events(call_id,agent_id,event_type,state,
        freeswitch_event_name,freeswitch_event_uuid,agent_leg_uuid,customer_leg_uuid,raw_json)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict do nothing`,
        [
          input.callId,
          leg.agent_id,
          input.playback
            ? `voicemail_playback_${input.playback}`
            : `freeswitch_${input.eventName.toLowerCase()}`,
          call.state,
          input.eventName,
          input.eventUuid,
          leg.type === "agent" ? input.legUuid : null,
          leg.type === "customer" ? input.legUuid : null,
          input.raw ?? {}
        ]
      );
      if (clean) {
        await client.query(
          `update call_legs set state='ended',ended_at=coalesce(ended_at,clock_timestamp())
          where id=$1`,
          [leg.id]
        );
        await client.query(
          `update call_participants set left_at=coalesce(left_at,clock_timestamp()),
          end_reason=coalesce(end_reason,$2) where id=$1`,
          [leg.participant_id, input.hangupCause ?? input.eventName]
        );
      } else if (
        !ended &&
        !input.playback &&
        [
          "CHANNEL_CREATE",
          "CHANNEL_PROGRESS",
          "CHANNEL_PROGRESS_MEDIA",
          "CHANNEL_ANSWER",
          "CHANNEL_BRIDGE"
        ].includes(input.eventName) &&
        !call.ended_at &&
        !terminal(call.state) &&
        !leg.left_at &&
        !leg.ended_at
      ) {
        await client.query(
          `update call_legs set state=case when $2='CHANNEL_ANSWER' then 'answered'
          when state='created' then 'started' else state end,
          answered_at=case when $2='CHANNEL_ANSWER' then coalesce(answered_at,clock_timestamp()) else answered_at end
          where id=$1 and state<>'ended'`,
          [leg.id, input.eventName]
        );
        if (leg.type === "customer" && input.eventName === "CHANNEL_ANSWER")
          await client.query(
            `update calls set pstn_answered_at=coalesce(pstn_answered_at,clock_timestamp())
            where id=$1 and ended_at is null`,
            [input.callId]
          );
      }
      const vm = ["voicemail_drop_requested", "voicemail_playback_started", "agent_released"].includes(
        call.state
      );
      if (leg.type === "customer" && !call.ended_at && !terminal(call.state)) {
        if (input.playback === "started" && vm)
          await client.query(
            `update calls set state=case when state='agent_released' then state else 'voicemail_playback_started' end,
            voicemail_playback_started_at=coalesce(voicemail_playback_started_at,clock_timestamp()) where id=$1`,
            [input.callId]
          );
        if (ended || (vm && ["completed", "failed"].includes(input.playback ?? ""))) {
          const requestedEnd = ended
            ? (
                await client.query(
                  `select o.request->>'endOutcome' as outcome
            from call_operations o join call_execution_attempts a on a.operation_id=o.id
            where o.call_id=$1 and o.target_uuid=$2 and o.command_kind='hangup'
              and o.request->>'controlAction'='end' and o.state in ('executing','uncertain','succeeded')
            order by a.started_at limit 1`,
                  [input.callId, input.legUuid]
                )
              ).rows[0]?.outcome
            : null;
          const outcome: CallOutcome =
            input.playback === "completed"
              ? "voicemail_dropped"
              : input.playback === "failed"
                ? "failed"
                : vm && ["NORMAL_CLEARING", "ORIGINATOR_CANCEL"].includes(input.hangupCause ?? "")
                  ? "voicemail_dropped"
                  : ["answered", "agent_canceled"].includes(requestedEnd)
                    ? requestedEnd
                    : resolveCustomerHangupOutcome({
                        answered: Boolean(call.pstn_answered_at || call.answered_at),
                        hangupCause: input.hangupCause,
                        voicemailDetected: call.voicemail_signal_status === "detected"
                      });
          const failed = outcome === "failed";
          await client.query(
            `update calls set state=$2,outcome=coalesce(outcome,$3),ended_at=clock_timestamp(),
            freeswitch_terminal_at=coalesce(freeswitch_terminal_at,$4),terminal_persisted_at=clock_timestamp(),
            terminal_source='freeswitch_concrete_leg',terminal_event_name=$5,
            voicemail_playback_completed_at=case when $6 then coalesce(voicemail_playback_completed_at,clock_timestamp()) else voicemail_playback_completed_at end,
            updated_at=clock_timestamp() where id=$1 and ended_at is null and manual_status_locked_at is null`,
            [
              input.callId,
              failed ? "failed" : "completed",
              outcome,
              input.eventAt ?? null,
              input.eventName,
              input.playback === "completed"
            ]
          );
        }
      }
      await settleCleanup(admission, input.callId);
    });
    return true;
  } finally {
    client.release();
  }
}

/** Re-run after C03 has independently resolved/quiesced every possible sender.
 * Uses persisted COMPLETE/DESTROY evidence only: a probe returning false, a TTL,
 * a command ACK or a playback-completed custom event never ends another leg.
 */
export async function reconcileCoordinatedCallCleanup(pool: pg.Pool, callId: string) {
  const client = await pool.connect();
  try {
    return await withCallAdmission(client, { callIds: [callId] }, (a) => settleCleanup(a, callId, true));
  } finally {
    client.release();
  }
}

async function settleCleanup(admission: CallAdmission, callId: string, cleanupRequested = false) {
  const db = admission.client;
  if (!(await isCoordinatedCall(db, callId))) return { slots: 0, resources: 0, uncertain: false };
  const call = (await db.query("select * from calls where id=$1", [callId])).rows[0];
  if (!call) return { slots: 0, resources: 0, uncertain: false };
  const unresolved = Boolean(
    (
      await db.query("select 1 from call_operations where call_id=$1 and resolved_at is null limit 1", [
        callId
      ])
    ).rowCount
  );
  const participants = (
    await db.query(
      `select p.*,l.id as leg_id,l.ended_at as leg_ended_at from call_participants p
    left join call_legs l on l.participant_id=p.id where p.call_id=$1 order by p.id`,
      [callId]
    )
  ).rows;
  if (!cleanupRequested && !call.ended_at && !participants.some((p) => p.left_at))
    return { slots: 0, resources: 0, uncertain: unresolved };
  const capacity = (
    await db.query(
      "select * from call_capacity_reservations where call_id=$1 and state<>'released' order by id",
      [callId]
    )
  ).rows;
  let slots = 0,
    resources = 0;
  for (const p of participants) {
    if (p.role !== "agent" || !p.slot_reservation_id) continue;
    const token = {
      agentId: p.agent_id,
      callId,
      reservationId: p.slot_reservation_id,
      generation: p.slot_generation
    };
    if (unresolved) {
      await admission.transition(token, "uncertain");
      continue;
    }
    if (!p.leg_ended_at || !p.left_at) continue;
    if (await admission.release(token, true)) {
      slots++;
      if (
        call.agent_id === p.agent_id &&
        !call.ended_at &&
        ["voicemail_drop_requested", "voicemail_playback_started", "agent_released"].includes(call.state)
      ) {
        await db.query(
          `update calls set state='agent_released',agent_released_at=coalesce(agent_released_at,clock_timestamp()) where id=$1`,
          [callId]
        );
        await db.query(
          `insert into call_events(call_id,agent_id,event_type,state,agent_leg_uuid,raw_json)
          values($1,$2,'agent_released','agent_released',(select freeswitch_uuid from call_legs where id=$3),'{"evidence":"concrete_terminal_cleanup"}') on conflict do nothing`,
          [callId, p.agent_id, p.leg_id]
        );
      }
      await finishAgentCall(db, p.agent_id);
    }
  }
  // Child/operation work precedes capacity, which precedes contact cleanup.
  for (const r of capacity) {
    const token = { id: r.id, operationId: r.operation_id, callId, generation: r.generation };
    if (unresolved) {
      await admission.capacity.transition(token, "uncertain");
      continue;
    }
    const concrete = r.call_leg_id ? participants.find((p) => p.leg_id === r.call_leg_id) : null;
    const browser = participants.find(
      (p) =>
        p.role === "agent" &&
        p.agent_id === r.agent_id &&
        p.slot_generation === r.generation &&
        p.leg_ended_at &&
        p.left_at
    );
    const customerDone =
      call.ended_at &&
      participants.some((p) => p.role === "customer") &&
      participants
        .filter((p) => ["customer", "external"].includes(p.role))
        .every((p) => p.leg_ended_at && p.left_at);
    const confirmed = r.call_leg_id
      ? concrete &&
        concrete.leg_ended_at &&
        concrete.left_at &&
        (r.resource_type !== "browser_channel" || concrete.role === "agent")
      : r.resource_type === "browser_channel"
        ? browser
        : ["customer_channel", "trunk_call", "queue_waiting", "external_forward"].includes(r.resource_type)
          ? customerDone
          : false;
    if (confirmed && (await admission.capacity.release(token, true))) resources++;
  }
  if (call.direction === "outbound" && call.contact_id && call.ended_at && !unresolved) {
    await db.query("select id from contacts where id=$1 for update", [call.contact_id]);
    await db.query(
      `update contacts set status=case when $3 in ('answered','customer_hung_up','voicemail_detected','voicemail_dropped') then 'completed' else 'new' end,
      updated_at=clock_timestamp() where id=$1 and status='calling' and not exists(
        select 1 from calls where contact_id=$1 and id<>$2 and ended_at is null)`,
      [call.contact_id, callId, call.outcome]
    );
  }
  return { slots, resources, uncertain: unresolved };
}
