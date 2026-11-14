import type pg from "pg";

export interface ParticipationTimes {
  arrivedAt: Date | null;
  pstnAnsweredAt: Date | null;
  agentConnectedAt: Date | null;
  queueExitedAt: Date | null;
  fallbackStartedAt: Date | null;
  endedAt: Date | null;
}

// Missing evidence stays unknown. PSTN answer is never a queue exit/agent bridge.
export function participationTiming(times: ParticipationTimes) {
  const duration = (from: Date | null, to: Date | null) =>
    from && to && to >= from ? to.getTime() - from.getTime() : null;
  const exit = times.queueExitedAt ?? times.agentConnectedAt ?? times.fallbackStartedAt ?? times.endedAt;
  return {
    queueWaitMs: duration(times.arrivedAt, exit),
    pstnToAgentMs: duration(times.pstnAnsweredAt, times.agentConnectedAt)
  };
}

// Internal read model for B05/H03. Not exposed through legacy API response shapes.
export async function getCallParticipationHistory(pool: pg.Pool, callId: string) {
  const result = await pool.query<{
    id: string;
    direction: "inbound" | "outbound";
    campaign_id: string | null;
    agent_id: string | null;
    original_did: string | null;
    calling_number: string | null;
    called_number: string | null;
    inbound_queue_id: string | null;
    arrived_at: Date | null;
    pstn_answered_at: Date | null;
    agent_connected_at: Date | null;
    queue_exited_at: Date | null;
    fallback_started_at: Date | null;
    ended_at: Date | null;
    participants: Array<{
      id: string;
      agentId: string | null;
      role: string;
      joinedAt: string | null;
      connectedAt: string | null;
      leftAt: string | null;
      callLegId: string | null;
      freeswitchUuid: string | null;
      connectedMs: number | null;
    }>;
  }>(
    `select c.*, coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'agentId',p.agent_id,'role',p.role,'joinedAt',p.joined_at,
      'connectedAt',p.connected_at,'leftAt',p.left_at,'callLegId',l.id,
      'freeswitchUuid',l.freeswitch_uuid,
      'connectedMs',extract(epoch from (p.left_at-p.connected_at))*1000)
      order by p.joined_at nulls last,p.id)
      from call_participants p left join call_legs l on l.participant_id=p.id
      where p.call_id=c.id),'[]'::jsonb) as participants
    from calls c where c.id=$1`,
    [callId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    callId: row.id,
    direction: row.direction,
    campaignId: row.campaign_id,
    currentAgentId: row.agent_id,
    originalDid: row.original_did,
    callingNumber: row.calling_number,
    calledNumber: row.called_number,
    queueId: row.inbound_queue_id,
    ...participationTiming({
      arrivedAt: row.arrived_at,
      pstnAnsweredAt: row.pstn_answered_at,
      agentConnectedAt: row.agent_connected_at,
      queueExitedAt: row.queue_exited_at,
      fallbackStartedAt: row.fallback_started_at,
      endedAt: row.ended_at
    }),
    participants: row.participants
  };
}
