import type {
  AdminAnalyticsResponse,
  AgentAvailabilityStatus,
  CampaignStatus
} from "@outbound-dialer/shared";
import type pg from "pg";
import { z } from "zod";
import type { ContactRetryPolicy } from "./campaigns.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RANGE_MS = 366 * DAY_MS;
const supportedTimeZones = new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);

const analyticsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  campaignId: z.string().uuid().optional(),
  timeZone: z
    .string()
    .max(100)
    .refine((value) => supportedTimeZones.has(value), "timeZone must be a supported IANA time zone")
    .default("UTC")
});

export type AnalyticsFilters = {
  from: Date;
  to: Date;
  campaignId: string | null;
  timeZone: string;
};

type OverviewRow = {
  attempts: string | number;
  unique_contacts: string | number;
  answered: string | number;
  connected: string | number;
  average_talk_seconds: string | number | null;
  failed: string | number;
  voicemail_requested: string | number;
  voicemail_started: string | number;
  agent_released: string | number;
  voicemail_completed: string | number;
  voicemail_failed_or_interrupted: string | number;
  average_release_seconds: string | number | null;
  completed: string | number;
};

type DailyRow = {
  date: string | Date;
  attempts: string | number;
  answered: string | number;
  connected: string | number;
  failed: string | number;
  voicemail_completed: string | number;
  average_talk_seconds: string | number | null;
};

type CampaignRow = {
  id: string;
  name: string;
  status: CampaignStatus;
  loaded: string | number;
  callable: string | number;
  attempted_contacts: string | number;
  attempts: string | number;
  answered: string | number;
  connected: string | number;
  average_talk_seconds: string | number | null;
  repeated_contacts: string | number;
  connected_repeated_contacts: string | number;
  voicemail_completed: string | number;
};

type AgentRow = {
  id: string;
  name: string;
  is_active: boolean;
  registered: boolean;
  availability_status: AgentAvailabilityStatus;
  active_call: boolean;
  attempts: string | number;
  answered: string | number;
  connected: string | number;
  average_talk_seconds: string | number | null;
  voicemail_drops: string | number;
  failed: string | number;
};

type DataQualityRow = {
  total_contacts: string | number;
  callable: string | number;
  suppressed: string | number;
  exhausted: string | number;
  imported_rows: string | number;
  rejected_rows: string | number;
  duplicate_rows: string | number;
};

export function parseAnalyticsFilters(input: unknown, now = new Date()): AnalyticsFilters {
  const query = analyticsQuerySchema.parse(input);
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() - 6));
  const rangeMs = to.getTime() - from.getTime();
  if (rangeMs < 0) {
    throw new z.ZodError([{ code: "custom", path: ["from"], message: "from must be before or equal to to" }]);
  }
  if (rangeMs > MAX_RANGE_MS) {
    throw new z.ZodError([
      { code: "custom", path: ["from"], message: "Analytics range cannot exceed 366 days" }
    ]);
  }
  return { from, to, campaignId: query.campaignId ?? null, timeZone: query.timeZone };
}

export async function getAdminAnalytics(
  pool: pg.Pool,
  filters: AnalyticsFilters,
  retryPolicy: ContactRetryPolicy,
  snapshotAt = new Date()
): Promise<AdminAnalyticsResponse> {
  const rangeParams = [filters.from, filters.to, filters.campaignId];
  const dailyParams = [...rangeParams, filters.timeZone];
  const snapshotParams = [...rangeParams, retryPolicy.maxAttempts, retryPolicy.retryDelaySeconds, snapshotAt];

  const [overview, daily, campaigns, agents, quality] = await Promise.all([
    pool.query<OverviewRow>(overviewSql, rangeParams),
    pool.query<DailyRow>(dailySql, dailyParams),
    pool.query<CampaignRow>(campaignSql, snapshotParams),
    pool.query<AgentRow>(agentSql, rangeParams),
    pool.query<DataQualityRow>(dataQualitySql, snapshotParams)
  ]);

  return buildAdminAnalyticsResponse(
    filters,
    snapshotAt,
    overview.rows[0],
    daily.rows,
    campaigns.rows,
    agents.rows,
    quality.rows[0]
  );
}

function buildAdminAnalyticsResponse(
  filters: AnalyticsFilters,
  snapshotAt: Date,
  overviewRow: OverviewRow | undefined,
  dailyRows: DailyRow[],
  campaignRows: CampaignRow[],
  agentRows: AgentRow[],
  qualityRow: DataQualityRow | undefined
): AdminAnalyticsResponse {
  const attempts = integer(overviewRow?.attempts);
  const answered = integer(overviewRow?.answered);
  const connected = integer(overviewRow?.connected);
  const voicemailRequested = integer(overviewRow?.voicemail_requested);
  const voicemailCompleted = integer(overviewRow?.voicemail_completed);
  const completed = integer(overviewRow?.completed);
  const duplicateRows = integer(qualityRow?.duplicate_rows);
  const rejectedRows = integer(qualityRow?.rejected_rows);

  return {
    filters: {
      from: filters.from.toISOString(),
      to: filters.to.toISOString(),
      campaignId: filters.campaignId,
      timeZone: filters.timeZone
    },
    summary: {
      attempts,
      uniqueContacts: integer(overviewRow?.unique_contacts),
      answered,
      answerRate: percent(answered, attempts),
      connected,
      contactRate: percent(connected, attempts),
      averageTalkSeconds: integer(overviewRow?.average_talk_seconds),
      failed: integer(overviewRow?.failed),
      voicemailCompleted,
      voicemailCompletionRate: percent(voicemailCompleted, voicemailRequested)
    },
    funnel: [
      { stage: "Attempts", count: attempts },
      { stage: "Answered", count: answered },
      { stage: "Connected", count: connected },
      { stage: "Completed", count: completed }
    ],
    dailyTrend: dailyRows.map((row) => ({
      date: dateOnly(row.date),
      attempts: integer(row.attempts),
      answered: integer(row.answered),
      connected: integer(row.connected),
      failed: integer(row.failed),
      voicemailCompleted: integer(row.voicemail_completed),
      averageTalkSeconds: integer(row.average_talk_seconds)
    })),
    campaignPerformance: campaignRows.map((row) => {
      const campaignAttempts = integer(row.attempts);
      const campaignConnected = integer(row.connected);
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        loaded: integer(row.loaded),
        callable: integer(row.callable),
        attemptedContacts: integer(row.attempted_contacts),
        attempts: campaignAttempts,
        answered: integer(row.answered),
        connected: campaignConnected,
        contactRate: percent(campaignConnected, campaignAttempts),
        averageTalkSeconds: integer(row.average_talk_seconds),
        retryEfficiency: percent(integer(row.connected_repeated_contacts), integer(row.repeated_contacts)),
        voicemailCompleted: integer(row.voicemail_completed)
      };
    }),
    agentPerformance: agentRows.map((row) => {
      const agentAttempts = integer(row.attempts);
      const agentConnected = integer(row.connected);
      return {
        id: row.id,
        name: row.name,
        isActive: row.is_active,
        registered: row.registered,
        availabilityStatus: row.availability_status,
        activeCall: row.active_call,
        attempts: agentAttempts,
        answered: integer(row.answered),
        connected: agentConnected,
        contactRate: percent(agentConnected, agentAttempts),
        averageTalkSeconds: integer(row.average_talk_seconds),
        voicemailDrops: integer(row.voicemail_drops),
        failed: integer(row.failed)
      };
    }),
    dataQuality: {
      snapshotAt: snapshotAt.toISOString(),
      totalContacts: integer(qualityRow?.total_contacts),
      callable: integer(qualityRow?.callable),
      suppressed: integer(qualityRow?.suppressed),
      exhausted: integer(qualityRow?.exhausted),
      importedRows: integer(qualityRow?.imported_rows),
      rejectedRows,
      duplicateRows,
      invalidRows: Math.max(0, rejectedRows - duplicateRows)
    },
    voicemail: {
      requested: voicemailRequested,
      started: integer(overviewRow?.voicemail_started),
      agentReleased: integer(overviewRow?.agent_released),
      completed: voicemailCompleted,
      failedOrInterrupted: integer(overviewRow?.voicemail_failed_or_interrupted),
      completionRate: percent(voicemailCompleted, voicemailRequested),
      averageReleaseSeconds: integer(overviewRow?.average_release_seconds)
    }
  };
}

function integer(value: string | number | null | undefined): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.round(numeric) : 0;
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1_000) / 10 : 0;
}

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

// "Answered" is SIP answer. "Connected" excludes known voicemail outcomes.
// Talk time only uses calls with a persisted end timestamp, avoiding ever-growing live-call averages.
const connectedPredicate = `
  calls.answered_at is not null
  and coalesce(calls.outcome, '') not in ('voicemail_detected', 'voicemail_dropped')
`;

const overviewSql = `
  with filtered_calls as (
    select calls.*
    from calls
    where calls.created_at >= $1
      and calls.created_at <= $2
      and ($3::uuid is null or calls.campaign_id = $3)
  )
  select
    count(*) as attempts,
    count(distinct coalesce(contact_id::text, 'number:' || normalized_destination_number)) as unique_contacts,
    count(*) filter (where answered_at is not null) as answered,
    count(*) filter (where answered_at is not null and coalesce(outcome, '') not in ('voicemail_detected', 'voicemail_dropped')) as connected,
    avg(greatest(0, extract(epoch from (ended_at - answered_at)))) filter (
      where answered_at is not null
        and ended_at is not null
        and coalesce(outcome, '') not in ('voicemail_detected', 'voicemail_dropped')
    ) as average_talk_seconds,
    count(*) filter (where outcome = 'failed') as failed,
    count(*) filter (where voicemail_drop_requested_at is not null) as voicemail_requested,
    count(*) filter (where voicemail_playback_started_at is not null) as voicemail_started,
    count(*) filter (where agent_released_at is not null) as agent_released,
    count(*) filter (where voicemail_playback_completed_at is not null) as voicemail_completed,
    count(*) filter (where exists (
      select 1 from call_events
      where call_events.call_id = filtered_calls.id
        and call_events.event_type in ('voicemail_playback_failed', 'voicemail_playback_interrupted')
    )) as voicemail_failed_or_interrupted,
    avg(greatest(0, extract(epoch from (agent_released_at - voicemail_drop_requested_at)))) filter (
      where agent_released_at is not null and voicemail_drop_requested_at is not null
    ) as average_release_seconds,
    count(*) filter (
      where answered_at is not null
        and ended_at is not null
        and outcome is not null
        and outcome not in ('voicemail_detected', 'voicemail_dropped', 'failed')
    ) as completed
  from filtered_calls
`;

const dailySql = `
  with days as (
    select generate_series(
      ($1::timestamptz at time zone $4::text)::date,
      ($2::timestamptz at time zone $4::text)::date,
      interval '1 day'
    )::date as date
  ), filtered_calls as (
    select calls.*
    from calls
    where calls.created_at >= $1
      and calls.created_at <= $2
      and ($3::uuid is null or calls.campaign_id = $3)
  ), daily as (
    select
      (calls.created_at at time zone $4::text)::date as date,
      count(*) as attempts,
      count(*) filter (where calls.answered_at is not null) as answered,
      count(*) filter (where ${connectedPredicate}) as connected,
      count(*) filter (where calls.outcome = 'failed') as failed,
      count(*) filter (where calls.voicemail_playback_completed_at is not null) as voicemail_completed,
      avg(greatest(0, extract(epoch from (calls.ended_at - calls.answered_at)))) filter (
        where ${connectedPredicate} and calls.ended_at is not null
      ) as average_talk_seconds
    from filtered_calls calls
    group by (calls.created_at at time zone $4::text)::date
  )
  select
    days.date,
    coalesce(daily.attempts, 0) as attempts,
    coalesce(daily.answered, 0) as answered,
    coalesce(daily.connected, 0) as connected,
    coalesce(daily.failed, 0) as failed,
    coalesce(daily.voicemail_completed, 0) as voicemail_completed,
    coalesce(daily.average_talk_seconds, 0) as average_talk_seconds
  from days
  left join daily using (date)
  order by days.date
`;

const campaignSql = `
  with filtered_calls as (
    select calls.*
    from calls
    where calls.created_at >= $1
      and calls.created_at <= $2
      and ($3::uuid is null or calls.campaign_id = $3)
  ), call_stats as (
    select
      campaign_id,
      count(*) as attempts,
      count(distinct contact_id) filter (where contact_id is not null) as attempted_contacts,
      count(*) filter (where answered_at is not null) as answered,
      count(*) filter (where answered_at is not null and coalesce(outcome, '') not in ('voicemail_detected', 'voicemail_dropped')) as connected,
      avg(greatest(0, extract(epoch from (ended_at - answered_at)))) filter (
        where answered_at is not null
          and ended_at is not null
          and coalesce(outcome, '') not in ('voicemail_detected', 'voicemail_dropped')
      ) as average_talk_seconds,
      count(*) filter (where voicemail_playback_completed_at is not null) as voicemail_completed
    from filtered_calls
    group by campaign_id
  ), repeated_contacts as (
    select
      campaign_id,
      count(*) as repeated_contacts,
      count(*) filter (where connected) as connected_repeated_contacts
    from (
      select
        campaign_id,
        contact_id,
        bool_or(answered_at is not null and coalesce(outcome, '') not in ('voicemail_detected', 'voicemail_dropped')) as connected
      from filtered_calls
      where contact_id is not null
      group by campaign_id, contact_id
      having count(*) > 1
    ) repeated
    group by campaign_id
  ), contact_stats as (
    select
      contacts.campaign_id,
      count(*) as loaded,
      count(*) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
          and contacts.attempt_count < $4
          and (
            contacts.last_attempted_at is null
            or contacts.last_attempted_at <= $6::timestamptz - make_interval(secs => $5)
          )
      ) as callable
    from contacts
    left join suppression_entries
      on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    group by contacts.campaign_id
  )
  select
    campaigns.id,
    campaigns.name,
    campaigns.status,
    coalesce(contact_stats.loaded, 0) as loaded,
    coalesce(contact_stats.callable, 0) as callable,
    coalesce(call_stats.attempted_contacts, 0) as attempted_contacts,
    coalesce(call_stats.attempts, 0) as attempts,
    coalesce(call_stats.answered, 0) as answered,
    coalesce(call_stats.connected, 0) as connected,
    coalesce(call_stats.average_talk_seconds, 0) as average_talk_seconds,
    coalesce(repeated_contacts.repeated_contacts, 0) as repeated_contacts,
    coalesce(repeated_contacts.connected_repeated_contacts, 0) as connected_repeated_contacts,
    coalesce(call_stats.voicemail_completed, 0) as voicemail_completed
  from campaigns
  left join contact_stats on contact_stats.campaign_id = campaigns.id
  left join call_stats on call_stats.campaign_id = campaigns.id
  left join repeated_contacts on repeated_contacts.campaign_id = campaigns.id
  where ($3::uuid is null or campaigns.id = $3)
  order by campaigns.created_at desc
`;

const agentSql = `
  with filtered_calls as (
    select calls.*
    from calls
    where calls.created_at >= $1
      and calls.created_at <= $2
      and ($3::uuid is null or calls.campaign_id = $3)
  ), call_stats as (
    select
      agent_id,
      count(*) as attempts,
      count(*) filter (where answered_at is not null) as answered,
      count(*) filter (where answered_at is not null and coalesce(outcome, '') not in ('voicemail_detected', 'voicemail_dropped')) as connected,
      avg(greatest(0, extract(epoch from (ended_at - answered_at)))) filter (
        where answered_at is not null
          and ended_at is not null
          and coalesce(outcome, '') not in ('voicemail_detected', 'voicemail_dropped')
      ) as average_talk_seconds,
      count(*) filter (where voicemail_playback_completed_at is not null) as voicemail_drops,
      count(*) filter (where outcome = 'failed') as failed
    from filtered_calls
    group by agent_id
  )
  select
    agents.id,
    users.name,
    users.is_active,
    agents.registered,
    agents.availability_status,
    exists (
      select 1 from calls active_calls
      where active_calls.agent_id = agents.id
        and active_calls.ended_at is null
        and active_calls.state not in ('completed', 'failed', 'canceled', 'agent_released')
    ) as active_call,
    coalesce(call_stats.attempts, 0) as attempts,
    coalesce(call_stats.answered, 0) as answered,
    coalesce(call_stats.connected, 0) as connected,
    coalesce(call_stats.average_talk_seconds, 0) as average_talk_seconds,
    coalesce(call_stats.voicemail_drops, 0) as voicemail_drops,
    coalesce(call_stats.failed, 0) as failed
  from agents
  join users on users.id = agents.user_id
  left join call_stats on call_stats.agent_id = agents.id
  order by users.name asc, agents.created_at asc
`;

const dataQualitySql = `
  with contact_quality as (
    select
      count(*) as total_contacts,
      count(*) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
          and contacts.attempt_count < $4
          and (
            contacts.last_attempted_at is null
            or contacts.last_attempted_at <= $6::timestamptz - make_interval(secs => $5)
          )
      ) as callable,
      count(*) filter (
        where contacts.status = 'suppressed' or suppression_entries.id is not null
      ) as suppressed,
      count(*) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
          and contacts.attempt_count >= $4
      ) as exhausted
    from contacts
    left join suppression_entries
      on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    where ($3::uuid is null or contacts.campaign_id = $3)
  ), import_quality as (
    select
      coalesce(sum(csv_imports.imported_rows), 0) as imported_rows,
      coalesce(sum(csv_imports.failed_rows), 0) as rejected_rows,
      coalesce(sum(coalesce((csv_imports.field_mapping_json ->> 'duplicateRows')::integer, 0)), 0) as duplicate_rows
    from csv_imports
    where csv_imports.created_at >= $1
      and csv_imports.created_at <= $2
      and ($3::uuid is null or csv_imports.campaign_id = $3)
  )
  select contact_quality.*, import_quality.*
  from contact_quality cross join import_quality
`;

export const __testing = {
  buildAdminAnalyticsResponse,
  percent,
  overviewSql,
  dailySql,
  campaignSql,
  agentSql,
  dataQualitySql
};
