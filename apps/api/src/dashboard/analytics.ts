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

type AvmdQualityRow = {
  eligible_calls: string | number;
  reviewed_calls: string | number;
  uncertain_reviews: string | number;
  true_positives: string | number;
  false_positives: string | number;
  true_negatives: string | number;
  false_negatives: string | number;
};

type MediaOverviewRow = {
  answered_calls: string | number;
  observed_calls: string | number;
  suspected_one_way_calls: string | number;
  average_mos: string | number | null;
  p95_jitter_loss_rate: string | number | null;
  average_quality_percentage: string | number | null;
  providers: Array<{ provider: string; count: number }>;
};

type MediaLegRow = {
  leg_type: "agent" | "customer";
  observed_calls: string | number;
  average_mos: string | number | null;
  p95_jitter_loss_rate: string | number | null;
  average_quality_percentage: string | number | null;
  codecs: Array<{ codec: string; count: number }>;
};

type BrowserMediaRow = {
  answered_calls: string | number;
  observed_calls: string | number;
  average_inbound_loss_rate: string | number | null;
  average_concealed_sample_rate: string | number | null;
  average_jitter_buffer_ms: string | number | null;
  p95_jitter_ms: string | number | null;
  p95_round_trip_time_ms: string | number | null;
  paths: Array<{ path: string; count: number }>;
};

type TelephonyReliabilityRow = {
  finalization_samples: string | number;
  average_finalization_ms: string | number | null;
  p95_finalization_ms: string | number | null;
  max_finalization_ms: string | number | null;
  registration_db_count: number | null;
  registration_freeswitch_count: number | null;
  registration_drift_count: number | null;
  registration_corrections_last_run: number | null;
  registration_reconciled_at: Date | null;
  active_calls_db_count: number | null;
  active_calls_missing_in_freeswitch: number | null;
  active_calls_closed_last_run: number | null;
  active_calls_reconciled_at: Date | null;
  reconciliation_closures: string | number;
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

  const [overview, daily, campaigns, agents, quality, avmd, media, mediaLegs, browserMedia, telephony] =
    await Promise.all([
      pool.query<OverviewRow>(overviewSql, rangeParams),
      pool.query<DailyRow>(dailySql, dailyParams),
      pool.query<CampaignRow>(campaignSql, snapshotParams),
      pool.query<AgentRow>(agentSql, rangeParams),
      pool.query<DataQualityRow>(dataQualitySql, snapshotParams),
      pool.query<AvmdQualityRow>(avmdQualitySql, rangeParams),
      pool.query<MediaOverviewRow>(mediaOverviewSql, rangeParams),
      pool.query<MediaLegRow>(mediaLegsSql, rangeParams),
      pool.query<BrowserMediaRow>(browserMediaSql, rangeParams),
      pool.query<TelephonyReliabilityRow>(telephonyReliabilitySql, rangeParams)
    ]);

  return buildAdminAnalyticsResponse(
    filters,
    snapshotAt,
    overview.rows[0],
    daily.rows,
    campaigns.rows,
    agents.rows,
    quality.rows[0],
    avmd.rows[0],
    media.rows[0],
    mediaLegs.rows,
    browserMedia.rows[0],
    telephony.rows[0]
  );
}

function buildAdminAnalyticsResponse(
  filters: AnalyticsFilters,
  snapshotAt: Date,
  overviewRow: OverviewRow | undefined,
  dailyRows: DailyRow[],
  campaignRows: CampaignRow[],
  agentRows: AgentRow[],
  qualityRow: DataQualityRow | undefined,
  avmdRow: AvmdQualityRow | undefined,
  mediaRow: MediaOverviewRow | undefined,
  mediaLegRows: MediaLegRow[],
  browserMediaRow: BrowserMediaRow | undefined,
  telephonyRow: TelephonyReliabilityRow | undefined
): AdminAnalyticsResponse {
  const attempts = integer(overviewRow?.attempts);
  const answered = integer(overviewRow?.answered);
  const connected = integer(overviewRow?.connected);
  const voicemailRequested = integer(overviewRow?.voicemail_requested);
  const voicemailCompleted = integer(overviewRow?.voicemail_completed);
  const completed = integer(overviewRow?.completed);
  const duplicateRows = integer(qualityRow?.duplicate_rows);
  const rejectedRows = integer(qualityRow?.rejected_rows);
  const eligibleCalls = integer(avmdRow?.eligible_calls);
  const reviewedCalls = integer(avmdRow?.reviewed_calls);
  const truePositives = integer(avmdRow?.true_positives);
  const falsePositives = integer(avmdRow?.false_positives);
  const trueNegatives = integer(avmdRow?.true_negatives);
  const falseNegatives = integer(avmdRow?.false_negatives);
  const answeredMediaCalls = integer(mediaRow?.answered_calls);
  const observedMediaCalls = integer(mediaRow?.observed_calls);

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
    },
    avmdQuality: {
      eligibleCalls,
      reviewedCalls,
      uncertainReviews: integer(avmdRow?.uncertain_reviews),
      reviewCoverageRate: percent(reviewedCalls, eligibleCalls),
      truePositives,
      falsePositives,
      trueNegatives,
      falseNegatives,
      precision: nullablePercent(truePositives, truePositives + falsePositives),
      recall: nullablePercent(truePositives, truePositives + falseNegatives),
      falsePositiveRate: nullablePercent(falsePositives, falsePositives + trueNegatives)
    },
    mediaQuality: {
      answeredCalls: answeredMediaCalls,
      observedCalls: observedMediaCalls,
      coverageRate: percent(observedMediaCalls, answeredMediaCalls),
      suspectedOneWayCalls: integer(mediaRow?.suspected_one_way_calls),
      averageMos: nullableNumber(mediaRow?.average_mos),
      p95JitterLossRate: nullableNumber(mediaRow?.p95_jitter_loss_rate),
      averageQualityPercentage: nullableNumber(mediaRow?.average_quality_percentage),
      providers: mediaRow?.providers ?? [],
      browser: {
        observedCalls: integer(browserMediaRow?.observed_calls),
        coverageRate: percent(
          integer(browserMediaRow?.observed_calls),
          integer(browserMediaRow?.answered_calls)
        ),
        averageInboundLossRate: nullableNumber(browserMediaRow?.average_inbound_loss_rate),
        averageConcealedSampleRate: nullableNumber(browserMediaRow?.average_concealed_sample_rate),
        averageJitterBufferMs: nullableNumber(browserMediaRow?.average_jitter_buffer_ms),
        p95JitterMs: nullableNumber(browserMediaRow?.p95_jitter_ms),
        p95RoundTripTimeMs: nullableNumber(browserMediaRow?.p95_round_trip_time_ms),
        paths: browserMediaRow?.paths ?? []
      },
      legs: mediaLegRows.map((row) => ({
        legType: row.leg_type,
        observedCalls: integer(row.observed_calls),
        averageMos: nullableNumber(row.average_mos),
        p95JitterLossRate: nullableNumber(row.p95_jitter_loss_rate),
        averageQualityPercentage: nullableNumber(row.average_quality_percentage),
        codecs: row.codecs ?? []
      }))
    },
    telephonyReliability: {
      finalizationSamples: integer(telephonyRow?.finalization_samples),
      averageFinalizationMs: nullableNumber(telephonyRow?.average_finalization_ms),
      p95FinalizationMs: nullableNumber(telephonyRow?.p95_finalization_ms),
      maxFinalizationMs: nullableNumber(telephonyRow?.max_finalization_ms),
      registrationDatabaseCount: nullableNumber(telephonyRow?.registration_db_count),
      registrationFreeSwitchCount: nullableNumber(telephonyRow?.registration_freeswitch_count),
      registrationDriftCount: nullableNumber(telephonyRow?.registration_drift_count),
      registrationCorrectionsLastRun: nullableNumber(telephonyRow?.registration_corrections_last_run),
      registrationReconciledAt: telephonyRow?.registration_reconciled_at?.toISOString() ?? null,
      activeCallsDatabaseCount: nullableNumber(telephonyRow?.active_calls_db_count),
      activeCallsMissingInFreeSwitch: nullableNumber(telephonyRow?.active_calls_missing_in_freeswitch),
      activeCallsClosedLastRun: nullableNumber(telephonyRow?.active_calls_closed_last_run),
      activeCallsReconciledAt: telephonyRow?.active_calls_reconciled_at?.toISOString() ?? null,
      reconciliationClosures: integer(telephonyRow?.reconciliation_closures)
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

function nullablePercent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? percent(numerator, denominator) : null;
}

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 10) / 10 : null;
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

const avmdQualitySql = `
  with eligible as (
    select
      calls.id,
      coalesce(calls.voicemail_signal_status, 'none') = 'detected' as predicted_machine,
      call_avmd_reviews.actual_party
    from calls
    left join call_avmd_reviews on call_avmd_reviews.call_id = calls.id
    where calls.created_at >= $1
      and calls.created_at <= $2
      and ($3::uuid is null or calls.campaign_id = $3)
      and calls.answered_at is not null
      and calls.ended_at is not null
      and exists (
        select 1 from call_events
        where call_events.call_id = calls.id
          and call_events.event_type = 'voicemail_detection_started'
      )
  )
  select
    count(*) as eligible_calls,
    count(*) filter (where actual_party is not null) as reviewed_calls,
    count(*) filter (where actual_party = 'uncertain') as uncertain_reviews,
    count(*) filter (where predicted_machine and actual_party = 'machine') as true_positives,
    count(*) filter (where predicted_machine and actual_party = 'human') as false_positives,
    count(*) filter (where not predicted_machine and actual_party = 'human') as true_negatives,
    count(*) filter (where not predicted_machine and actual_party = 'machine') as false_negatives
  from eligible
`;

const mediaOverviewSql = `
  with filtered_calls as (
    select
      id,
      answered_at,
      greatest(0, extract(epoch from (ended_at - answered_at))) as duration_seconds
    from calls
    where calls.created_at >= $1
      and calls.created_at <= $2
      and ($3::uuid is null or calls.campaign_id = $3)
  ), observed as (
    select call_media_stats.*, filtered_calls.duration_seconds
    from call_media_stats
    join filtered_calls on filtered_calls.id = call_media_stats.call_id
    where filtered_calls.answered_at is not null
  )
  select
    (select count(*) from filtered_calls where answered_at is not null) as answered_calls,
    count(distinct call_id) as observed_calls,
    count(distinct call_id) filter (
      where duration_seconds >= 10
        and coalesce(inbound_media_packet_count, inbound_packet_count) is not null
        and coalesce(outbound_media_packet_count, outbound_packet_count) is not null
        and (
          (coalesce(inbound_media_packet_count, inbound_packet_count) <= 5
            and coalesce(outbound_media_packet_count, outbound_packet_count) >= 50)
          or (coalesce(outbound_media_packet_count, outbound_packet_count) <= 5
            and coalesce(inbound_media_packet_count, inbound_packet_count) >= 50)
        )
    ) as suspected_one_way_calls,
    avg(inbound_mos) as average_mos,
    percentile_cont(0.95) within group (order by inbound_jitter_loss_rate)
      filter (where inbound_jitter_loss_rate is not null) as p95_jitter_loss_rate,
    avg(inbound_quality_percentage) as average_quality_percentage,
    coalesce((
      select jsonb_agg(
        jsonb_build_object('provider', provider, 'count', count)
        order by count desc, provider
      )
      from (
        select coalesce(sip_gateway, sip_profile) as provider, count(distinct call_id)::int as count
        from observed provider_stats
        where leg_type = 'customer'
          and coalesce(sip_gateway, sip_profile) is not null
        group by coalesce(sip_gateway, sip_profile)
      ) provider_counts
    ), '[]'::jsonb) as providers
  from observed
`;

const mediaLegsSql = `
  with filtered_stats as (
    select call_media_stats.*
    from call_media_stats
    join calls on calls.id = call_media_stats.call_id
    where calls.created_at >= $1
      and calls.created_at <= $2
      and ($3::uuid is null or calls.campaign_id = $3)
      and calls.answered_at is not null
  ), leg_stats as (
    select
      leg_type,
      count(distinct call_id) as observed_calls,
      avg(inbound_mos) as average_mos,
      percentile_cont(0.95) within group (order by inbound_jitter_loss_rate)
        filter (where inbound_jitter_loss_rate is not null) as p95_jitter_loss_rate,
      avg(inbound_quality_percentage) as average_quality_percentage
    from filtered_stats
    group by leg_type
  ), codec_counts as (
    select leg_type, coalesce(read_codec, write_codec) as codec, count(*)::int as count
    from filtered_stats
    where coalesce(read_codec, write_codec) is not null
    group by leg_type, coalesce(read_codec, write_codec)
  ), codecs as (
    select
      leg_type,
      jsonb_agg(jsonb_build_object('codec', codec, 'count', count) order by count desc, codec) as codecs
    from codec_counts
    group by leg_type
  )
  select
    leg_stats.*,
    coalesce(codecs.codecs, '[]'::jsonb) as codecs
  from leg_stats
  left join codecs using (leg_type)
  order by case leg_type when 'agent' then 0 else 1 end
`;

const browserMediaSql = `
  with filtered_calls as (
    select id
    from calls
    where calls.created_at >= $1
      and calls.created_at <= $2
      and ($3::uuid is null or calls.campaign_id = $3)
      and calls.answered_at is not null
  ), observed as (
    select call_browser_media_stats.*
    from call_browser_media_stats
    join filtered_calls on filtered_calls.id = call_browser_media_stats.call_id
  )
  select
    (select count(*) from filtered_calls) as answered_calls,
    count(*) as observed_calls,
    avg(
      100.0 * inbound_packets_lost
      / nullif(inbound_packets_received + inbound_packets_lost, 0)
    ) as average_inbound_loss_rate,
    avg(
      100.0 * inbound_concealed_samples
      / nullif(inbound_total_samples_received, 0)
    ) as average_concealed_sample_rate,
    avg(
      1000.0 * inbound_jitter_buffer_delay_seconds
      / nullif(inbound_jitter_buffer_emitted_count, 0)
    ) as average_jitter_buffer_ms,
    percentile_cont(0.95) within group (order by inbound_jitter_seconds_max * 1000.0)
      filter (where inbound_jitter_seconds_max is not null) as p95_jitter_ms,
    percentile_cont(0.95) within group (order by outbound_round_trip_time_seconds_max * 1000.0)
      filter (where outbound_round_trip_time_seconds_max is not null) as p95_round_trip_time_ms,
    coalesce((
      select jsonb_agg(
        jsonb_build_object('path', path, 'count', count)
        order by count desc, path
      )
      from (
        select
          concat_ws(' -> ', coalesce(local_candidate_type, 'unknown'), coalesce(remote_candidate_type, 'unknown')) as path,
          count(*)::int as count
        from observed path_stats
        group by local_candidate_type, remote_candidate_type
      ) path_counts
    ), '[]'::jsonb) as paths
  from observed
`;

const telephonyReliabilitySql = `
  with filtered_calls as (
    select *
    from calls
    where calls.created_at >= $1
      and calls.created_at <= $2
      and ($3::uuid is null or calls.campaign_id = $3)
  ), reliability as (
    select
      count(finalization_latency_ms) as finalization_samples,
      avg(finalization_latency_ms) as average_finalization_ms,
      percentile_cont(0.95) within group (order by finalization_latency_ms)
        filter (where finalization_latency_ms is not null) as p95_finalization_ms,
      max(finalization_latency_ms) as max_finalization_ms,
      count(*) filter (
        where terminal_source = 'active_call_reconciliation'
          or exists (
            select 1 from call_events
            where call_events.call_id = filtered_calls.id
              and call_events.event_type = 'freeswitch_reconciliation_closed_missing_call'
          )
      ) as reconciliation_closures
    from filtered_calls
  )
  select reliability.*, observability.*
  from reliability
  left join telephony_observability_state observability on observability.singleton = true
`;

export const __testing = {
  buildAdminAnalyticsResponse,
  percent,
  overviewSql,
  dailySql,
  campaignSql,
  agentSql,
  dataQualitySql,
  avmdQualitySql,
  mediaOverviewSql,
  mediaLegsSql,
  browserMediaSql,
  telephonyReliabilitySql,
  nullablePercent
};
