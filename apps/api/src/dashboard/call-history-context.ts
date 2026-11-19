import type pg from "pg";
import type { CallHistoryContext, CallJourney } from "@outbound-dialer/shared";

// Each scalar subquery preserves one product-call row. Never join all the
// one-to-many history tables into a call count or a participation duration.
export const historyContextSql = `jsonb_build_object(
  'direction',calls.direction,'did',calls.original_did,'queueId',calls.inbound_queue_id,
  'queueName',(select name from inbound_queues where id=calls.inbound_queue_id),
  'callingNumber',calls.calling_number,'calledNumber',calls.called_number,
  'queueWaitMs',case when calls.arrived_at is not null and calls.queue_exited_at is not null
    then greatest(0,extract(epoch from(calls.queue_exited_at-calls.arrived_at))*1000) end,
  'queueExit',case when calls.queue_exited_at is null then null
    when calls.fallback_started_at is not null and calls.agent_connected_at is null then 'timeout'
    when calls.agent_connected_at is not null then 'agent_connected'
    else calls.inbound_end_reason end,
  'terminalReason',calls.inbound_end_reason,
  'manualCorrectionAt',calls.manual_status_locked_at,
  'agentTalkMs',(select sum(extract(epoch from(upper(r)-lower(r)))*1000)
    from (select unnest(range_agg(tstzrange(p.connected_at,least(p.left_at,calls.ended_at),'[)'))) r
      from call_participants p where p.call_id=calls.id and p.role='agent'
      and p.connected_at is not null and p.left_at is not null and calls.ended_at is not null
      and p.connected_at<least(p.left_at,calls.ended_at)) intervals),
  'participantCount',(select count(*) from call_participants p where p.call_id=calls.id),
  'transferCount',(select count(*) from call_transfers t where t.call_id=calls.id),
  'flowOutcome',(select o.result->>'outcome' from call_operations o
    where o.call_id=calls.id and o.request->>'inboundFallback'='true'
    and o.command_kind<>'hangup' order by o.created_at desc,o.id desc limit 1)
)`;

export async function getCallJourney(pool: pg.Pool, callId: string): Promise<CallJourney> {
  const [participants, offers, transfers, steps] = await Promise.all([
    pool.query(
      `select p.id,p.role,p.agent_id as "agentId",u.name as "agentName",
      p.external_number as "externalNumber",p.joined_at as "joinedAt",
      p.connected_at as "connectedAt",p.left_at as "leftAt",p.end_reason as "endReason",
      (extract(epoch from(p.left_at-p.connected_at))*1000)::float8 as "connectedMs",
      l.id as "legId",l.freeswitch_uuid as "legUuid",
      case when m.call_leg_id is not null then jsonb_build_object(
        'capturedAt',m.captured_at,'inboundPackets',m.inbound_media_packet_count,
        'outboundPackets',m.outbound_media_packet_count,'mos',m.inbound_mos) end as media,
      case when b.participant_id is not null then jsonb_build_object(
        'capturedAt',b.captured_at,'startedAt',b.started_at,'endedAt',b.ended_at,
        'sampleCount',b.sample_count,'packetsReceived',b.inbound_packets_received,
        'packetsSent',b.outbound_packets_sent) end as "browserMedia",count(*) over() as total
      from call_participants p left join agents a on a.id=p.agent_id
      left join users u on u.id=a.user_id left join call_legs l on l.participant_id=p.id
      left join call_leg_media_stats m on m.call_leg_id=l.id
      left join call_participant_browser_media_stats b on b.participant_id=p.id
      where p.call_id=$1 order by p.joined_at nulls last,p.id limit 200`,
      [callId]
    ),
    pool.query(
      `select o.id,o.kind,o.agent_id as "agentId",u.name as "agentName",o.attempt,
      o.state,o.reason,o.created_at as "createdAt",o.closed_at as "closedAt",count(*) over() as total
      from call_offers o join agents a on a.id=o.agent_id join users u on u.id=a.user_id
      where o.call_id=$1 order by o.created_at,o.id limit 200`,
      [callId]
    ),
    pool.query(
      `select t.id,t.attempt,t.source_agent_id as "sourceAgentId",
      s.name as "sourceName",t.recipient_agent_id as "recipientAgentId",r.name as "recipientName",
      t.state,t.reason,t.created_at as "createdAt",t.closed_at as "closedAt",count(*) over() as total
      from call_transfers t join agents sa on sa.id=t.source_agent_id join users s on s.id=sa.user_id
      join agents ra on ra.id=t.recipient_agent_id join users r on r.id=ra.user_id
      where t.call_id=$1 order by t.attempt,t.id limit 200`,
      [callId]
    ),
    pool.query(
      `select id,request->>'step' as step,request->>'flowVersionId' as "flowVersionId",
      command_kind as action,state,result->>'outcome' as outcome,result->>'reason' as reason,
      created_at as "createdAt",resolved_at as "resolvedAt",count(*) over() as total
      from call_operations where call_id=$1 and request->>'inboundFallback'='true'
      order by created_at,id limit 200`,
      [callId]
    )
  ]);
  const page = (result: pg.QueryResult) => ({
    items: result.rows.map(({ total: _total, ...row }) => row),
    total: Number(result.rows[0]?.total ?? 0),
    truncated: Number(result.rows[0]?.total ?? 0) > result.rows.length
  });
  // PG dates/decimal strings are normalized by JSON just like an HTTP response.
  return JSON.parse(
    JSON.stringify({
      participants: page(participants),
      offers: page(offers),
      transfers: page(transfers),
      steps: page(steps)
    })
  ) as CallJourney;
}

export type HistoryContextRow = { history_context: CallHistoryContext };
