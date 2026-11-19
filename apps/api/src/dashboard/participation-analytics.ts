import type pg from "pg";
import type { AdminAnalyticsResponse } from "@outbound-dialer/shared";
import type { AnalyticsFilters } from "./analytics.js";

// Union intervals before summing: repeated visits and overlapping snapshots
// must not multiply the customer conversation or an agent's time.
export const nativeTalkSecondsSql = `(select sum(extract(epoch from(upper(r)-lower(r))))
  from (select unnest(range_agg(tstzrange(p.connected_at,least(p.left_at,calls.ended_at),'[)'))) r
    from call_participants p where p.call_id=calls.id and p.role in ('agent','external')
    and p.connected_at is not null and p.left_at is not null and calls.ended_at is not null
    and p.connected_at<least(p.left_at,calls.ended_at)) intervals)`;
export const talkSecondsSql = `case when exists(select 1 from call_participants p
  where p.call_id=calls.id and p.origin='native') then ${nativeTalkSecondsSql}
  else greatest(0,extract(epoch from(calls.ended_at-calls.answered_at))) end`;

export async function getParticipationAnalytics(
  pool: pg.Pool,
  filters: AnalyticsFilters
): Promise<Pick<AdminAnalyticsResponse, "inbound" | "participation">> {
  const result = await pool.query(
    `with filtered as (
    select * from calls where created_at >= $1 and created_at <= $2
      and ($3::uuid is null or campaign_id=$3)
  ), intervals as (
    select p.agent_id,c.id,c.direction,
      range_agg(tstzrange(p.connected_at,least(p.left_at,c.ended_at),'[)')) as spans
    from filtered c join call_participants p on p.call_id=c.id
    where p.role='agent' and p.connected_at is not null and p.left_at is not null
      and c.ended_at is not null and p.connected_at<least(p.left_at,c.ended_at)
    group by p.agent_id,c.id,c.direction
  ), durations as (
    select agent_id,id,direction,sum(extract(epoch from(upper(r)-lower(r)))*1000) as ms
    from intervals cross join lateral unnest(spans) r group by agent_id,id,direction
  ), attribution as (
    select d.agent_id,d.direction,u.name,count(*) as calls,sum(d.ms) as ms,
      sum((select count(*) from call_participants p join call_legs l on l.participant_id=p.id
        join call_leg_media_stats m on m.call_leg_id=l.id
        where p.call_id=d.id and p.agent_id=d.agent_id)) as media_legs,
      sum((select count(*) from call_participants p join call_participant_browser_media_stats b on b.participant_id=p.id
        where p.call_id=d.id and p.agent_id=d.agent_id)) as browser_segments
    from durations d join agents a on a.id=d.agent_id join users u on u.id=a.user_id
    group by d.agent_id,d.direction,u.name
  ) select jsonb_build_object(
    'calls',count(*),'agentConnected',count(*) filter(where agent_connected_at is not null),
    'queueTimeouts',count(*) filter(where fallback_started_at is not null),
    'averageWaitMs',avg(extract(epoch from(queue_exited_at-arrived_at))*1000),
    'transfers',coalesce(sum((select count(*) from call_transfers t where t.call_id=filtered.id)),0)
  ) as inbound,
  (select coalesce(jsonb_agg(jsonb_build_object('agentId',agent_id,'agentName',name,
    'direction',direction,'calls',calls,'connectedMs',ms,'mediaLegs',media_legs,
    'browserSegments',browser_segments) order by name,agent_id,direction),'[]'::jsonb) from attribution) as participation
  from filtered where direction='inbound'`,
    [filters.from, filters.to, filters.campaignId]
  );
  return result.rows[0];
}
