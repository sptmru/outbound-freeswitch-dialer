import type pg from "pg";
import type { CallOfferSnapshot, DeskMutationRequest } from "@outbound-dialer/shared";
import {
  AdmissionDiscoveryChanged,
  AdmissionError,
  withCallAdmission,
  type CallAdmission
} from "./call-admission.js";
import { expireInboundOffers } from "./call-offer-expiry.js";
import { requestFingerprint } from "./call-coordination-contracts.js";
import type { DeskActor } from "./desk-sessions.js";
import { inboundOfferBlockReason, inboundOfferTimeoutMs } from "./inbound-offer-policy.js";

// FIFO ordering and all deadlines remain in PostgreSQL (microsecond precision).
async function oldest(client: pg.PoolClient, agentId: string, campaignId: string) {
  return (
    await client.query(
      `select c.id from calls c join inbound_queue_admissions q on q.call_id=c.id
     where c.direction='inbound' and c.campaign_id=$2 and c.state='queued' and c.ended_at is null
       and c.queue_exited_at is null and c.fallback_started_at is null and c.queue_deadline_at>clock_timestamp()
       and not exists(select 1 from inbound_connection_attempts x where x.call_id=c.id
         and (x.settled_at is null or x.retry_at>clock_timestamp() or x.attempt>=3))
       and not exists(select 1 from call_offer_exclusions e where e.call_id=c.id and e.agent_id=$1)
       and not exists(select 1 from call_offers o where o.call_id=c.id and o.agent_id=$1 and o.kind='inbound'
         and o.state='pending' and o.deadline_at<=clock_timestamp())
     order by c.arrived_at,c.id limit 1`,
      [agentId, campaignId]
    )
  ).rows[0]?.id as string | undefined;
}

/** One bounded recipient transaction, shared by dispatch, snapshots and Ignore.
 * Pending calls and FIFO head are rediscovered after lock waits; a changed graph
 * is retried from discovery, with no ESL or external callbacks after commit.
 */
export async function withOfferRecipient<T>(
  pool: pg.Pool,
  agentId: string,
  extraCallIds: string[],
  work: (a: CallAdmission, desk: pg.QueryResultRow | undefined) => Promise<T>
) {
  const client = await pool.connect();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const discover = async () => {
        const desk = (
          await client.query("select * from agent_desk_sessions where agent_id=$1 and revoked_at is null", [
            agentId
          ])
        ).rows[0];
        const pending = (
          await client.query(
            "select call_id from call_offers where agent_id=$1 and state='pending' order by call_id",
            [agentId]
          )
        ).rows.map((r) => r.call_id as string);
        const head = desk?.campaign_id ? await oldest(client, agentId, desk.campaign_id) : undefined;
        return { desk, pending, head };
      };
      const found = await discover();
      try {
        return await withCallAdmission(
          client,
          {
            startsCall: true,
            allowPausedReplay: true,
            agentIds: [agentId],
            campaignIds: found.desk?.campaign_id ? [found.desk.campaign_id] : [],
            callIds: [...new Set([...extraCallIds, ...found.pending, ...(found.head ? [found.head] : [])])]
          },
          async (a) => {
            const fresh = await discover();
            if (
              fresh.desk?.id !== found.desk?.id ||
              fresh.desk?.campaign_id !== found.desk?.campaign_id ||
              fresh.head !== found.head ||
              JSON.stringify(fresh.pending) !== JSON.stringify(found.pending)
            )
              throw new AdmissionDiscoveryChanged();
            await expireInboundOffers(client, [agentId]);
            return work(a, fresh.desk);
          }
        );
      } catch (error) {
        if (!(error instanceof AdmissionDiscoveryChanged) || attempt === 2) throw error;
      }
    }
    throw new AdmissionDiscoveryChanged();
  } finally {
    client.release();
  }
}

async function snapshot(client: pg.PoolClient, agentId: string): Promise<CallOfferSnapshot | null> {
  const row = (
    await client.query(
      `select o.*,c.campaign_id,
       case when c.direction='outbound' then c.normalized_destination_number else c.calling_number end as calling_number
     from call_offers o join calls c on c.id=o.call_id
     where o.agent_id=$1 and o.state='pending'`,
      [agentId]
    )
  ).rows[0];
  return row
    ? {
        id: row.id,
        callId: row.call_id,
        kind: row.kind,
        transferId: row.transfer_id,
        state: row.state,
        deadlineAt: row.deadline_at.toISOString(),
        campaignId: row.campaign_id,
        callingNumber: row.calling_number ?? "unknown",
        closureReason: row.reason
      }
    : null;
}

function verifyController(
  desk: pg.QueryResultRow | undefined,
  actor: DeskActor,
  input: Pick<DeskMutationRequest, "deskSessionId">
) {
  if (!desk || desk.id !== input.deskSessionId || desk.actor_auth_version !== actor.authVersion)
    throw new AdmissionError("not_controller");
}

async function refresh(
  a: CallAdmission,
  desk: pg.QueryResultRow | undefined,
  agentId: string,
  create: boolean
) {
  const c = a.client;
  const user = (
    await c.query("select u.* from users u join agents a on a.user_id=u.id where a.id=$1", [agentId])
  ).rows[0];
  const decision = desk?.campaign_id
    ? await a.eligibility({
        agentId,
        userId: user.id,
        campaignId: desk.campaign_id,
        deskSessionId: desk.id,
        expectedRevision: desk.revision,
        bindingGeneration: desk.binding_generation
      })
    : null;
  const blocked = inboundOfferBlockReason(decision, desk?.actor_auth_version, user.auth_version);
  // Cancellation does not manufacture Ignore. Deadline expiry was processed first.
  await c.query(
    `with stamp as materialized(select clock_timestamp() as at)
    update call_offers o set state='canceled',reason='eligibility_changed',closed_at=stamp.at from stamp,calls call
    where o.call_id=call.id and o.agent_id=$1 and o.kind='inbound' and o.state='pending'
      and ($2::boolean or o.desk_session_id is distinct from $3::uuid or o.desk_revision is distinct from $4::bigint
        or o.binding_generation is distinct from $5::bigint or call.state<>'queued' or call.ended_at is not null
        or call.queue_exited_at is not null or call.fallback_started_at is not null or call.queue_deadline_at<=stamp.at)`,
    [agentId, blocked !== null, desk?.id ?? null, desk?.revision ?? null, desk?.binding_generation ?? null]
  );
  await c.query(
    `with stamp as materialized(select clock_timestamp() as at)
    update call_transfers t set state='canceled',reason='eligibility_changed',closed_at=stamp.at
    from stamp,call_offers o where o.transfer_id=t.id and t.state='offered' and o.state='pending'
      and o.agent_id=$1 and ($2::boolean or o.desk_session_id is distinct from $3::uuid
        or o.desk_revision is distinct from $4::bigint or o.binding_generation is distinct from $5::bigint)`,
    [agentId, blocked !== null, desk?.id ?? null, desk?.revision ?? null, desk?.binding_generation ?? null]
  );
  await expireInboundOffers(c, [agentId]);
  if (!create || blocked !== null || !desk) return snapshot(c, agentId);
  if (a.startPaused) return snapshot(c, agentId);
  // A pending transfer also occupies the single offer position.
  if ((await c.query("select 1 from call_offers where agent_id=$1 and state='pending'", [agentId])).rowCount)
    return snapshot(c, agentId);
  const callId = await oldest(c, agentId, desk.campaign_id);
  if (!callId) return null;
  a.assertExecutionCall(callId);
  // Preserve FIFO while FreeSWITCH is entering the waiting application. The
  // accept path cannot grant a connection until this exact job has succeeded.
  if (
    (
      await c.query(
        `select 1 from inbound_queue_admissions q join call_operations o on o.id=q.operation_id
      where q.call_id=$1 and o.state<>'succeeded'`,
        [callId]
      )
    ).rowCount
  )
    return null;
  const captured = (
    await c.query("select route_snapshot from inbound_ingress_evidence where call_id=$1", [callId])
  ).rows[0];
  const offerMs = inboundOfferTimeoutMs(captured.route_snapshot.configuration.offer_timeout_ms);
  await c.query(
    `with stamp as materialized(select clock_timestamp() as at)
    insert into call_offers(call_id,kind,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at)
    select call.id,'inbound',$2,coalesce((select max(attempt) from call_offers where call_id=call.id and agent_id=$2 and kind='inbound'),0)+1,
      $3,$4,$5,least(call.queue_deadline_at,stamp.at+make_interval(secs=>$6/1000.0))
    from calls call cross join stamp
    where call.id=$1 and call.queue_deadline_at>stamp.at`,
    [callId, agentId, desk.id, desk.revision, desk.binding_generation, offerMs]
  );
  return snapshot(c, agentId);
}

export async function dispatchInboundOffers(
  pool: pg.Pool,
  agentId: string,
  checkpoint?: (a: CallAdmission) => Promise<void>
) {
  return withOfferRecipient(pool, agentId, [], async (a, desk) => {
    const offer = await refresh(a, desk, agentId, true);
    await checkpoint?.(a);
    return offer;
  });
}

export async function readInboundOffer(pool: pg.Pool, actor: DeskActor, deskSessionId: string) {
  return withOfferRecipient(pool, actor.agentId, [], async (a, desk) => {
    await verifyActor(a.client, actor);
    verifyController(desk, actor, { deskSessionId });
    const offer = await refresh(a, desk, actor.agentId, false);
    return { revision: desk!.revision as string, offer };
  });
}

async function verifyActor(c: pg.PoolClient, actor: DeskActor) {
  const user = (
    await c.query(
      "select u.is_active,u.auth_version from users u join agents a on a.user_id=u.id where u.id=$1 and a.id=$2",
      [actor.userId, actor.agentId]
    )
  ).rows[0];
  if (!user?.is_active || user.auth_version !== actor.authVersion)
    throw new AdmissionError("session_revoked");
}

export async function ignoreInboundOffer(
  pool: pg.Pool,
  actor: DeskActor,
  offerId: string,
  input: DeskMutationRequest
) {
  const found = (
    await pool.query("select call_id from call_offers where id=$1 and agent_id=$2 and kind='inbound'", [
      offerId,
      actor.agentId
    ])
  ).rows[0];
  if (!found) throw new AdmissionError("not_owner");
  const fingerprint = requestFingerprint("POST", "/agent/call-offers/:offerId/ignore", offerId, input);
  return withOfferRecipient(pool, actor.agentId, [found.call_id], async (a, desk) => {
    const c = a.client;
    await verifyActor(c, actor);
    const old = (
      await c.query("select * from call_offer_mutations where actor_user_id=$1 and idempotency_key=$2", [
        actor.userId,
        input.idempotencyKey
      ])
    ).rows[0];
    if (old) {
      if (old.request_fingerprint !== fingerprint) throw new AdmissionError("idempotency_conflict");
      return { status: "applied" as const, revision: old.revision as string };
    }
    verifyController(desk, actor, input);
    if (desk!.revision !== input.expectedRevision || desk!.binding_generation !== input.bindingGeneration)
      throw new AdmissionError("revision_conflict");
    await refresh(a, desk, actor.agentId, false);
    const offer = (await c.query("select * from call_offers where id=$1", [offerId])).rows[0];
    // Return conflicts after committing independent due expiry, rather than
    // throwing/rolling back it and leaving a delayed timer as the only closer.
    if (offer.state !== "pending")
      return { conflict: offer.state === "expired" ? "offer_expired" : "offer_closed" };
    if (
      offer.desk_session_id !== input.deskSessionId ||
      offer.desk_revision !== input.expectedRevision ||
      offer.binding_generation !== input.bindingGeneration
    )
      throw new AdmissionError("revision_conflict");
    const closed = await c.query(
      `with stamp as materialized(select clock_timestamp() as at)
      update call_offers set state='ignored',reason='user_ignored',closed_at=stamp.at from stamp
      where id=$1 and state='pending' and deadline_at>stamp.at returning id`,
      [offerId]
    );
    if (!closed.rowCount) {
      await expireInboundOffers(c, [actor.agentId]);
      return { conflict: "offer_expired" };
    }
    await c.query(
      "insert into call_offer_mutations(actor_user_id,idempotency_key,offer_id,request_fingerprint,revision) values($1,$2,$3,$4,$5)",
      [actor.userId, input.idempotencyKey, offerId, fingerprint, desk!.revision]
    );
    return { status: "applied" as const, revision: desk!.revision as string };
  });
}

/** Explicitly started by the native runtime owner (I05). No overlapping ticks,
 * round-robin UUID cursor, at most 20 recipients/tick and one pooled connection
 * at a time. Polling covers lost SSE, becoming free and late timer execution.
 */
export function startInboundOfferDispatcher(pool: pg.Pool, report: (error: unknown) => void) {
  let running = false,
    stopped = false,
    after = "00000000-0000-0000-0000-000000000000";
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const agents = (
        await pool.query(
          `select id from agents where id>$1 and
        (exists(select 1 from agent_desk_sessions d where d.agent_id=agents.id and d.revoked_at is null)
        or exists(select 1 from call_offers o where o.agent_id=agents.id and o.state='pending'))
        order by id limit 20`,
          [after]
        )
      ).rows;
      if (!agents.length) after = "00000000-0000-0000-0000-000000000000";
      for (const agent of agents) {
        if (stopped) break;
        after = agent.id;
        try {
          await dispatchInboundOffers(pool, agent.id);
        } catch (error) {
          report(error);
        }
      }
    } catch (error) {
      report(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 250);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
