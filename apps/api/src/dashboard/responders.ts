import type pg from "pg";
import type {
  AdminOverviewResponse,
  AgentDeskResponse,
  CallActionAvailability,
  CallDetailResponse,
  CallHistoryItem,
  CallHistoryResponse,
  CallOutcome,
  CallPcapStatus,
  CallRecordingStatus,
  CallState,
  LeadSummary,
  PublicUser
} from "@outbound-dialer/shared";
import { getAgentAvailability } from "../agent-availability.js";
import { getUsers } from "./admin-libraries.js";
import { getAgentCampaign, getAgentCampaigns, getCampaigns, type ContactRetryPolicy } from "./campaigns.js";
import { getRecordings } from "./recordings.js";

export async function buildAgentDeskResponse(
  pool: pg.Pool,
  user: PublicUser,
  selectedCampaignId?: string,
  retryPolicy?: ContactRetryPolicy
): Promise<AgentDeskResponse> {
  const [
    campaign,
    availableCampaigns,
    availability,
    activeCall,
    metrics,
    recordings,
    recentCalls,
    voicemailJobs
  ] = await Promise.all([
    getAgentCampaign(pool, selectedCampaignId, { userId: user.id, ...retryPolicy }),
    getAgentCampaigns(pool, retryPolicy),
    getAgentAvailability(pool, user.id),
    getActiveCall(pool, user.id),
    getAgentMetrics(pool, user.id),
    getRecordings(pool),
    getAgentRecentCalls(pool, user.id),
    getAgentVoicemailJobs(pool, user.id)
  ]);
  const agentRecordings = recordings.map(({ id, name, status }) => ({ id, name, status }));
  if (!campaign) {
    return {
      user,
      availability,
      campaign: null,
      availableCampaigns,
      softphone: {
        registered: false,
        microphoneAllowed: true,
        status: activeCall ? "in_call" : "offline"
      },
      metrics,
      recentCalls,
      voicemailJobs,
      leads: [],
      recordings: agentRecordings,
      activeCall
    };
  }

  const leads = await getLeadQueue(pool, campaign.id, retryPolicy);

  return {
    user,
    availability,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      callableLeads: Number(campaign.callable_leads),
      manualDialingEnabled: campaign.manual_dialing_enabled,
      callRecordingEnabled: campaign.call_recording_enabled,
      earlyMediaAvmdEnabled: campaign.early_media_avmd_enabled
    },
    availableCampaigns,
    softphone: {
      registered: Boolean(campaign.agent_registered),
      microphoneAllowed: true,
      status: activeCall ? "in_call" : "ready"
    },
    metrics,
    recentCalls,
    voicemailJobs,
    leads,
    recordings: agentRecordings,
    activeCall
  };
}

export async function buildAdminOverviewResponse(
  pool: pg.Pool,
  user: PublicUser,
  retryPolicy?: ContactRetryPolicy
): Promise<AdminOverviewResponse> {
  const [stats, campaigns, recordings, users, callHistory, suppression] = await Promise.all([
    getAdminStats(pool),
    getCampaigns(pool, retryPolicy),
    getRecordings(pool),
    getUsers(pool),
    getCallHistory(pool),
    getSuppression(pool)
  ]);

  return {
    user,
    stats,
    campaigns,
    recordings,
    users,
    callHistory,
    suppression
  };
}

async function getLeadQueue(
  pool: pg.Pool,
  campaignId: string,
  retryPolicy?: ContactRetryPolicy
): Promise<LeadSummary[]> {
  const result = await pool.query<{
    id: string;
    display_name: string | null;
    phone_number: string;
    company: string | null;
    status: LeadSummary["status"];
    mapped_fields_json: Record<string, unknown>;
  }>(
    `
      select
        contacts.id,
        contacts.display_name,
        contacts.phone_number,
        contacts.mapped_fields_json,
        coalesce(contacts.mapped_fields_json ->> 'Company', contacts.mapped_fields_json ->> 'company') as company,
        case
          when suppression_entries.id is not null then 'suppressed'
          when contacts.status = 'calling' then 'calling'
          when contacts.status in ('completed', 'suppressed') then contacts.status
          when contacts.attempt_count >= $2 then 'exhausted'
          when contacts.last_attempted_at > now() - make_interval(secs => $3) then 'retry_wait'
          else 'ready'
        end as status
      from contacts
      left join suppression_entries
        on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where contacts.campaign_id = $1
      order by
        case
          when contacts.status not in ('calling', 'completed', 'suppressed')
            and suppression_entries.id is null
            and contacts.attempt_count < $2
            and (
              contacts.last_attempted_at is null
              or contacts.last_attempted_at <= now() - make_interval(secs => $3)
            ) then 0
          else 1
        end,
        contacts.last_attempted_at asc nulls first,
        contacts.created_at asc
      limit 25
    `,
    [campaignId, retryPolicy?.maxAttempts ?? 2_147_483_647, retryPolicy?.retryDelaySeconds ?? 0]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.display_name ?? "Unknown contact",
    company: row.company ?? "",
    phoneNumber: row.phone_number,
    status: row.status,
    fields: Object.entries(row.mapped_fields_json ?? {})
      .slice(0, 8)
      .map(([label, value]) => ({ label, value: String(value) }))
  }));
}

async function getActiveCall(pool: pg.Pool, userId: string): Promise<AgentDeskResponse["activeCall"]> {
  const result = await pool.query<{
    id: string;
    state: CallState;
    destination_number: string;
    contact_name: string | null;
    started_at: Date | null;
    answered_at: Date | null;
    voicemail_signal_status: string | null;
    recording_id: string | null;
    recording_name: string | null;
    customer_leg_uuid: string | null;
    call_recording_enabled: boolean;
    call_recording_status: CallRecordingStatus;
  }>(
    `
      select
        calls.id,
        calls.state,
        calls.destination_number,
        contacts.display_name as contact_name,
        calls.started_at,
        calls.answered_at,
        calls.voicemail_signal_status,
        calls.recording_id,
        calls.call_recording_enabled,
        calls.call_recording_status,
        recordings.name as recording_name,
        customer_leg.freeswitch_uuid as customer_leg_uuid
      from calls
      join agents on agents.id = calls.agent_id
      left join contacts on contacts.id = calls.contact_id
      left join recordings on recordings.id = calls.recording_id
      left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
      where agents.user_id = $1
        and calls.ended_at is null
        and calls.state not in ('completed', 'failed', 'canceled', 'agent_released')
      order by calls.created_at desc
      limit 1
    `,
    [userId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const startedAt = row.answered_at ?? row.started_at;
  const durationSeconds = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)) : 0;

  return {
    id: row.id,
    state: row.state,
    leadName: row.contact_name ?? "Manual dial",
    phoneNumber: row.destination_number,
    durationSeconds,
    status: mapCallStatus(row.state),
    voicemailSignal: mapVoicemailSignal(row.voicemail_signal_status),
    recordingId: row.recording_id,
    recordingName: row.recording_name ?? "No default recording",
    callRecordingEnabled: row.call_recording_enabled,
    callRecordingStatus: row.call_recording_enabled ? (row.call_recording_status ?? "pending") : "disabled",
    actions: getActiveCallActions(row.state, row.customer_leg_uuid),
    timeline: await getCallTimeline(pool, row.id)
  };
}

export function getActiveCallActions(
  state: CallState,
  customerLegUuid: string | null
): NonNullable<AgentDeskResponse["activeCall"]>["actions"] {
  const availability = getCustomerMediaActionAvailability(state, customerLegUuid);
  return {
    dropVoicemail: availability,
    sendDtmf: availability
  };
}

function getCustomerMediaActionAvailability(
  state: CallState,
  customerLegUuid: string | null
): CallActionAvailability {
  if (!customerLegUuid) {
    return { allowed: false, reason: "Waiting for the customer connection" };
  }
  if (state !== "bridged" && state !== "voicemail_signal_detected") {
    return { allowed: false, reason: "Available after the customer answers" };
  }
  return { allowed: true, reason: null };
}

async function getCallTimeline(pool: pg.Pool, callId: string): Promise<Array<{ at: string; label: string }>> {
  const result = await pool.query<{
    event_type: string;
    created_at: Date;
  }>(
    `
      select event_type, created_at
      from call_events
      where call_id = $1
      order by created_at asc
      limit 12
    `,
    [callId]
  );

  if (!result.rows.length) {
    return [{ at: "now", label: "Call created" }];
  }

  const first = result.rows[0]?.created_at.getTime() ?? Date.now();
  return result.rows.map((row) => ({
    at: formatElapsed(Math.floor((row.created_at.getTime() - first) / 1000)),
    label: humanize(row.event_type)
  }));
}

async function getAgentMetrics(pool: pg.Pool, userId: string): Promise<AgentDeskResponse["metrics"]> {
  const result = await pool.query<{
    today_calls: string;
    voicemails_dropped: string;
    suppressed: string;
  }>(
    `
      select
        count(calls.id) filter (where calls.created_at >= date_trunc('day', now())) as today_calls,
        count(calls.id) filter (where calls.outcome = 'voicemail_dropped') as voicemails_dropped,
        (select count(*) from suppression_entries) as suppressed
      from agents
      left join calls on calls.agent_id = agents.id
      where agents.user_id = $1
    `,
    [userId]
  );
  const row = result.rows[0];

  return {
    todayCalls: Number(row?.today_calls ?? 0),
    voicemailsDropped: Number(row?.voicemails_dropped ?? 0),
    suppressed: Number(row?.suppressed ?? 0)
  };
}

async function getAgentRecentCalls(pool: pg.Pool, userId: string): Promise<AgentDeskResponse["recentCalls"]> {
  const result = await pool.query<{
    id: string;
    destination_number: string;
    lead_name: string | null;
    outcome: CallOutcome | null;
    state: CallState;
    created_at: Date;
  }>(
    `
      select
        calls.id,
        calls.destination_number,
        contacts.display_name as lead_name,
        calls.outcome,
        calls.state,
        calls.created_at
      from calls
      join agents on agents.id = calls.agent_id
      left join contacts on contacts.id = calls.contact_id
      where agents.user_id = $1
        and calls.state in ('completed', 'failed', 'canceled', 'agent_released')
      order by calls.created_at desc
      limit 5
    `,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    phoneNumber: row.destination_number,
    leadName: row.lead_name ?? "Manual dial",
    outcome: row.outcome,
    state: row.state,
    createdAt: row.created_at.toISOString()
  }));
}

async function getAgentVoicemailJobs(
  pool: pg.Pool,
  userId: string
): Promise<AgentDeskResponse["voicemailJobs"]> {
  const result = await pool.query<{
    call_id: string;
    lead_name: string | null;
    destination_number: string;
    voicemail_drop_requested_at: Date;
    voicemail_playback_started_at: Date | null;
    voicemail_playback_completed_at: Date | null;
    interrupted_at: Date | null;
    failed_at: Date | null;
  }>(
    `
      select
        calls.id as call_id,
        contacts.display_name as lead_name,
        calls.destination_number,
        calls.voicemail_drop_requested_at,
        calls.voicemail_playback_started_at,
        calls.voicemail_playback_completed_at,
        interruption.created_at as interrupted_at,
        failure.created_at as failed_at
      from calls
      join agents on agents.id = calls.agent_id
      left join contacts on contacts.id = calls.contact_id
      left join lateral (
        select call_events.created_at
        from call_events
        where call_events.call_id = calls.id
          and call_events.event_type = 'voicemail_playback_interrupted'
        order by call_events.created_at desc
        limit 1
      ) interruption on true
      left join lateral (
        select call_events.created_at
        from call_events
        where call_events.call_id = calls.id
          and call_events.event_type = 'voicemail_playback_failed'
        order by call_events.created_at desc
        limit 1
      ) failure on true
      where agents.user_id = $1
        and calls.voicemail_drop_requested_at is not null
        and calls.voicemail_drop_requested_at >= now() - interval '24 hours'
      order by calls.voicemail_drop_requested_at desc
      limit 5
    `,
    [userId]
  );
  return result.rows.map((row) => {
    const status: AgentDeskResponse["voicemailJobs"][number]["status"] = row.voicemail_playback_completed_at
      ? "completed"
      : row.failed_at
        ? "failed"
        : row.interrupted_at
          ? "interrupted"
          : row.voicemail_playback_started_at
            ? "playing"
            : "requested";
    const updatedAt =
      row.voicemail_playback_completed_at ??
      row.failed_at ??
      row.interrupted_at ??
      row.voicemail_playback_started_at ??
      row.voicemail_drop_requested_at;
    return {
      callId: row.call_id,
      leadName: row.lead_name ?? "Manual dial",
      phoneNumber: row.destination_number,
      status,
      requestedAt: row.voicemail_drop_requested_at.toISOString(),
      updatedAt: updatedAt.toISOString()
    };
  });
}

async function getAdminStats(pool: pg.Pool): Promise<AdminOverviewResponse["stats"]> {
  const [result, outcomes] = await Promise.all([
    pool.query<{
      campaigns: string;
      active_agents: string;
      total_agents: string;
      calls_today: string;
      suppression_entries: string;
      live_calls: string;
      attempted_calls_today: string;
      answered_calls_today: string;
      voicemail_drops_today: string;
      voicemail_drop_completed_today: string;
      failed_calls_today: string;
      elapsed_business_hours: string;
    }>(`
    select
      (select count(*) from campaigns) as campaigns,
      (select count(*) from agents where status in ('ready', 'registered', 'in_call')) as active_agents,
      (select count(*) from agents) as total_agents,
      (select count(*) from calls where created_at >= date_trunc('day', now())) as calls_today,
      (select count(*) from suppression_entries) as suppression_entries,
      (select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled', 'agent_released')) as live_calls,
      (select count(*) from calls where created_at >= date_trunc('day', now())) as attempted_calls_today,
      (select count(*) from calls where created_at >= date_trunc('day', now()) and answered_at is not null) as answered_calls_today,
      (select count(*) from calls where created_at >= date_trunc('day', now()) and outcome = 'voicemail_dropped') as voicemail_drops_today,
      (select count(*) from calls where created_at >= date_trunc('day', now()) and voicemail_playback_completed_at is not null) as voicemail_drop_completed_today,
      (select count(*) from calls where created_at >= date_trunc('day', now()) and outcome = 'failed') as failed_calls_today,
      greatest(extract(epoch from (now() - date_trunc('day', now()))) / 3600, 1) as elapsed_business_hours
  `),
    pool.query<{ outcome: string; count: string }>(`
    select coalesce(outcome, state) as outcome, count(*) as count
    from calls
    where created_at >= date_trunc('day', now())
    group by coalesce(outcome, state)
    order by count(*) desc, coalesce(outcome, state)
  `)
  ]);
  const row = result.rows[0];

  const attemptedCallsToday = Number(row?.attempted_calls_today ?? 0);
  const answeredCallsToday = Number(row?.answered_calls_today ?? 0);
  const voicemailDropsToday = Number(row?.voicemail_drops_today ?? 0);
  const voicemailDropCompletedToday = Number(row?.voicemail_drop_completed_today ?? 0);
  const activeAgents = Number(row?.active_agents ?? 0);
  const totalAgents = Number(row?.total_agents ?? 0);

  return {
    campaigns: Number(row?.campaigns ?? 0),
    activeAgents,
    callsToday: Number(row?.calls_today ?? 0),
    suppressionEntries: Number(row?.suppression_entries ?? 0),
    liveCalls: Number(row?.live_calls ?? 0),
    attemptedCallsToday,
    answeredCallsToday,
    contactRate: attemptedCallsToday ? Math.round((answeredCallsToday / attemptedCallsToday) * 1000) / 10 : 0,
    voicemailDropsToday,
    voicemailDropCompletionRate: voicemailDropsToday
      ? Math.round((voicemailDropCompletedToday / voicemailDropsToday) * 1000) / 10
      : 0,
    failedCallsToday: Number(row?.failed_calls_today ?? 0),
    callsPerHour: Math.round((attemptedCallsToday / Number(row?.elapsed_business_hours ?? 1)) * 10) / 10,
    agentUtilization: totalAgents ? Math.round((activeAgents / totalAgents) * 1000) / 10 : 0,
    outcomeDistribution: outcomes.rows.map((outcome) => ({
      outcome: outcome.outcome,
      count: Number(outcome.count)
    }))
  };
}

async function getCallHistory(pool: pg.Pool): Promise<AdminOverviewResponse["callHistory"]> {
  return (await getCallHistoryPage(pool, { page: 1, pageSize: 20 })).items;
}

export type CallHistoryFilters = {
  page: number;
  pageSize: number;
  q?: string;
  campaignId?: string;
  agentId?: string;
  outcome?: CallOutcome;
  from?: Date;
  to?: Date;
  voicemail?: "drop" | "signal";
  recording?: "available" | "missing";
  avmdReview?: "needs_review" | "reviewed" | "uncertain";
  snapshot?: { createdAt: string; id: string };
  cursor?: { createdAt: string; id: string };
  includeTotal?: boolean;
};

export type CallHistoryPageBounds = {
  first: { createdAt: string; id: string } | null;
  last: { createdAt: string; id: string } | null;
};

const callHistoryPageBounds = new WeakMap<CallHistoryResponse, CallHistoryPageBounds>();

export function getCallHistoryPageBounds(page: CallHistoryResponse): CallHistoryPageBounds {
  return callHistoryPageBounds.get(page) ?? { first: null, last: null };
}

export async function getCallHistoryPage(
  pool: pg.Pool,
  filters: CallHistoryFilters
): Promise<CallHistoryResponse> {
  const offset = (filters.page - 1) * filters.pageSize;
  const result = await pool.query<{
    id: string;
    lead_name: string | null;
    agent_name: string | null;
    phone_number: string;
    campaign_name: string | null;
    campaign_id: string | null;
    agent_user_id: string | null;
    state: CallState;
    outcome: CallOutcome | null;
    created_at: Date;
    created_at_cursor: string;
    duration_seconds: number | null;
    recording_available: boolean;
    pcap_status: CallPcapStatus | null;
    pcap_available: boolean;
    voicemail_signal_status: string | null;
    avmd_review_status: "needs_review" | "reviewed" | "uncertain" | null;
    total_count: string | null;
  }>(
    `
    select
      calls.id,
      contacts.display_name as lead_name,
      users.name as agent_name,
      calls.destination_number as phone_number,
      campaigns.name as campaign_name,
      campaigns.id as campaign_id,
      users.id as agent_user_id,
      calls.state,
      calls.outcome,
      calls.created_at,
      to_char(calls.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_cursor,
      calls.call_recording_status = 'available' and calls.call_recording_path is not null as recording_available,
      call_pcaps.status as pcap_status,
      call_pcaps.status = 'available' and call_pcaps.file_path is not null as pcap_available,
      calls.voicemail_signal_status,
      case
        when calls.answered_at is null or calls.ended_at is null or not coalesce(avmd.attempted, false) then null
        when call_avmd_reviews.actual_party = 'uncertain' then 'uncertain'
        when call_avmd_reviews.call_id is not null then 'reviewed'
        else 'needs_review'
      end as avmd_review_status,
      ${filters.includeTotal === false ? "null::bigint" : "count(*) over()"} as total_count,
      extract(epoch from (coalesce(calls.ended_at, now()) - coalesce(calls.answered_at, calls.started_at, calls.created_at)))::int as duration_seconds
    from calls
    left join contacts on contacts.id = calls.contact_id
    left join agents on agents.id = calls.agent_id
    left join users on users.id = agents.user_id
    left join campaigns on campaigns.id = calls.campaign_id
    left join call_pcaps on call_pcaps.call_id = calls.id
    left join call_avmd_reviews on call_avmd_reviews.call_id = calls.id
    left join lateral (
      select true as attempted
      from call_events
      where call_events.call_id = calls.id
        and call_events.event_type = 'voicemail_detection_started'
      limit 1
    ) avmd on true
    where ($1::text is null or concat_ws(' ', contacts.display_name, calls.destination_number, users.name, campaigns.name) ilike '%' || $1 || '%')
      and ($2::uuid is null or calls.campaign_id = $2)
      and ($3::uuid is null or users.id = $3)
      and ($4::text is null or calls.outcome = $4)
      and ($5::timestamptz is null or calls.created_at >= $5)
      and ($6::timestamptz is null or calls.created_at <= $6)
      and (
        $7::text is null
        or ($7 = 'drop' and calls.voicemail_drop_requested_at is not null)
        or ($7 = 'signal' and calls.voicemail_signal_status is not null)
      )
      and (
        $8::text is null
        or ($8 = 'available' and calls.call_recording_status = 'available' and calls.call_recording_path is not null)
        or ($8 = 'missing' and (calls.call_recording_status <> 'available' or calls.call_recording_path is null))
      )
      and (
        $9::text is null
        or ($9 = 'needs_review' and calls.answered_at is not null and calls.ended_at is not null and coalesce(avmd.attempted, false) and call_avmd_reviews.call_id is null)
        or ($9 = 'reviewed' and call_avmd_reviews.actual_party in ('human', 'machine'))
        or ($9 = 'uncertain' and call_avmd_reviews.actual_party = 'uncertain')
      )
      and (
        $10::timestamptz is null
        or calls.created_at < $10
        or (calls.created_at = $10 and calls.id <= $11::uuid)
      )
      and (
        $12::timestamptz is null
        or calls.created_at < $12
        or (calls.created_at = $12 and calls.id < $13::uuid)
      )
    order by calls.created_at desc, calls.id desc
    limit $14 offset $15
  `,
    [
      filters.q?.trim() || null,
      filters.campaignId ?? null,
      filters.agentId ?? null,
      filters.outcome ?? null,
      filters.from ?? null,
      filters.to ?? null,
      filters.voicemail ?? null,
      filters.recording ?? null,
      filters.avmdReview ?? null,
      filters.snapshot?.createdAt ?? null,
      filters.snapshot?.id ?? null,
      filters.cursor?.createdAt ?? null,
      filters.cursor?.id ?? null,
      filters.pageSize,
      offset
    ]
  );

  const items: CallHistoryItem[] = result.rows.map((row) => ({
    id: row.id,
    leadName: row.lead_name ?? "Manual dial",
    agentName: row.agent_name ?? "Unassigned",
    phoneNumber: row.phone_number,
    campaignName: row.campaign_name ?? "No campaign",
    campaignId: row.campaign_id,
    agentId: row.agent_user_id,
    state: row.state,
    outcome: row.outcome,
    createdAt: row.created_at.toISOString(),
    durationSeconds: row.duration_seconds ?? 0,
    recordingAvailable: row.recording_available,
    pcapStatus: row.pcap_status,
    pcapAvailable: row.pcap_available,
    voicemailSignal: row.voicemail_signal_status,
    avmdReviewStatus: row.avmd_review_status
  }));
  const total = Number(result.rows[0]?.total_count ?? 0);
  const response: CallHistoryResponse = {
    items,
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: total ? Math.ceil(total / filters.pageSize) : 0
  };
  const firstRow = result.rows[0];
  const lastRow = result.rows.at(-1);
  callHistoryPageBounds.set(response, {
    first: firstRow
      ? { createdAt: firstRow.created_at_cursor ?? firstRow.created_at.toISOString(), id: firstRow.id }
      : null,
    last: lastRow
      ? { createdAt: lastRow.created_at_cursor ?? lastRow.created_at.toISOString(), id: lastRow.id }
      : null
  });
  return response;
}

export async function getCallDetail(pool: pg.Pool, callId: string): Promise<CallDetailResponse | null> {
  const result = await pool.query<{
    id: string;
    lead_name: string | null;
    agent_name: string | null;
    phone_number: string;
    campaign_name: string | null;
    campaign_id: string | null;
    agent_user_id: string | null;
    state: CallState;
    outcome: CallOutcome | null;
    created_at: Date;
    started_at: Date | null;
    answered_at: Date | null;
    ended_at: Date | null;
    manual_dial: boolean;
    duration_seconds: number | null;
    call_recording_path: string | null;
    call_recording_enabled: boolean;
    call_recording_status: CallRecordingStatus;
    call_recording_duration_seconds: number | null;
    call_recording_file_size_bytes: string | number | null;
    call_recording_integrity_checked_at: Date | null;
    call_recording_failure_reason: string | null;
    pcap_status: CallPcapStatus | null;
    pcap_file_size_bytes: string | number | null;
    pcap_started_at: Date | null;
    pcap_ended_at: Date | null;
    pcap_failure_reason: string | null;
    pcap_file_path: string | null;
    voicemail_signal_status: string | null;
    voicemail_confidence: number | null;
    avmd_attempted: boolean;
    freeswitch_terminal_at: Date | null;
    terminal_persisted_at: Date | null;
    terminal_source: string | null;
    terminal_event_name: string | null;
    finalization_latency_ms: number | null;
  }>(
    `
      select
        calls.id,
        contacts.display_name as lead_name,
        users.name as agent_name,
        calls.destination_number as phone_number,
        campaigns.name as campaign_name,
        campaigns.id as campaign_id,
        users.id as agent_user_id,
        calls.state,
        calls.outcome,
        calls.created_at,
        calls.started_at,
        calls.answered_at,
        calls.ended_at,
        calls.manual_dial,
        calls.call_recording_enabled,
        calls.call_recording_path,
        calls.call_recording_status,
        calls.call_recording_duration_seconds,
        calls.call_recording_file_size_bytes,
        calls.call_recording_integrity_checked_at,
        calls.call_recording_failure_reason,
        call_pcaps.status as pcap_status,
        call_pcaps.file_size_bytes as pcap_file_size_bytes,
        call_pcaps.started_at as pcap_started_at,
        call_pcaps.ended_at as pcap_ended_at,
        call_pcaps.failure_reason as pcap_failure_reason,
        call_pcaps.file_path as pcap_file_path,
        calls.voicemail_signal_status,
        calls.freeswitch_terminal_at,
        calls.terminal_persisted_at,
        calls.terminal_source,
        calls.terminal_event_name,
        calls.finalization_latency_ms,
        exists (
          select 1 from call_events
          where call_events.call_id = calls.id
            and call_events.event_type = 'voicemail_detection_started'
        ) as avmd_attempted,
        voicemail.confidence as voicemail_confidence,
        extract(epoch from (coalesce(calls.ended_at, now()) - coalesce(calls.answered_at, calls.started_at, calls.created_at)))::int as duration_seconds
      from calls
      left join contacts on contacts.id = calls.contact_id
      left join agents on agents.id = calls.agent_id
      left join users on users.id = agents.user_id
      left join campaigns on campaigns.id = calls.campaign_id
      left join call_pcaps on call_pcaps.call_id = calls.id
      left join lateral (
        select voicemail_detection_events.confidence
        from voicemail_detection_events
        where voicemail_detection_events.call_id = calls.id
        order by voicemail_detection_events.created_at desc
        limit 1
      ) voicemail on true
      where calls.id = $1
      limit 1
    `,
    [callId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const [events, legs, reviews, mediaQuality, browserMedia] = await Promise.all([
    pool.query<CallDetailEventRow>(
      `
        select
          event_type,
          state,
          reason_code,
          freeswitch_event_name,
          api_command_name,
          agent_leg_uuid,
          customer_leg_uuid,
          raw_json,
          created_at,
          total_count
        from (
          select
            id,
            event_type,
            state,
            reason_code,
            freeswitch_event_name,
            api_command_name,
            agent_leg_uuid,
            customer_leg_uuid,
            raw_json,
            created_at,
            count(*) over() as total_count
          from call_events
          where call_id = $1
          order by created_at desc, id desc
          limit 100
        ) recent_events
        order by created_at asc, id asc
      `,
      [callId]
    ),
    pool.query<{
      type: "agent" | "customer";
      state: string;
      freeswitch_uuid: string | null;
      sip_uri: string | null;
      started_at: Date | null;
      answered_at: Date | null;
      ended_at: Date | null;
    }>(
      `
        select type, state, freeswitch_uuid, sip_uri, started_at, answered_at, ended_at
        from call_legs
        where call_id = $1
        order by case type when 'agent' then 0 else 1 end
      `,
      [callId]
    ),
    pool.query<{
      actual_party: "human" | "machine" | "uncertain";
      notes: string | null;
      reviewed_by_name: string;
      reviewed_at: Date;
      updated_at: Date;
    }>(
      `
        select actual_party, notes, reviewed_by_name, reviewed_at, updated_at
        from call_avmd_reviews
        where call_id = $1
      `,
      [callId]
    ),
    pool.query<{
      leg_type: "agent" | "customer";
      captured_at: Date;
      read_codec: string | null;
      write_codec: string | null;
      sip_gateway: string | null;
      sip_profile: string | null;
      inbound_packet_count: string | number | null;
      outbound_packet_count: string | number | null;
      inbound_media_packet_count: string | number | null;
      outbound_media_packet_count: string | number | null;
      inbound_skip_packet_count: string | number | null;
      inbound_jitter_loss_rate: string | number | null;
      inbound_jitter_max_variance: string | number | null;
      inbound_mos: string | number | null;
      inbound_quality_percentage: string | number | null;
    }>(
      `
        select
          leg_type,
          captured_at,
          read_codec,
          write_codec,
          sip_gateway,
          sip_profile,
          inbound_packet_count,
          outbound_packet_count,
          inbound_media_packet_count,
          outbound_media_packet_count,
          inbound_skip_packet_count,
          inbound_jitter_loss_rate,
          inbound_jitter_max_variance,
          inbound_mos,
          inbound_quality_percentage
        from call_media_stats
        where call_id = $1
        order by case leg_type when 'agent' then 0 else 1 end
      `,
      [callId]
    ),
    pool.query<{
      schema_version: 1;
      started_at: Date;
      ended_at: Date;
      captured_at: Date;
      sample_count: number;
      microphone_sample_rate: number | null;
      microphone_sample_size: number | null;
      microphone_channel_count: number | null;
      microphone_echo_cancellation: boolean | null;
      microphone_noise_suppression: boolean | null;
      microphone_auto_gain_control: boolean | null;
      microphone_latency_seconds: string | number | null;
      inbound_codec: string | null;
      inbound_packets_received: string | number | null;
      inbound_packets_lost: string | number | null;
      inbound_packets_discarded: string | number | null;
      inbound_jitter_seconds_max: string | number | null;
      inbound_jitter_buffer_delay_seconds: string | number | null;
      inbound_jitter_buffer_emitted_count: string | number | null;
      inbound_concealed_samples: string | number | null;
      inbound_total_samples_received: string | number | null;
      inbound_concealment_events: string | number | null;
      inbound_audio_energy: string | number | null;
      inbound_audio_duration_seconds: string | number | null;
      outbound_codec: string | null;
      outbound_packets_sent: string | number | null;
      outbound_bytes_sent: string | number | null;
      outbound_remote_packets_lost: string | number | null;
      outbound_remote_jitter_seconds_max: string | number | null;
      outbound_round_trip_time_seconds_max: string | number | null;
      local_candidate_type: string | null;
      remote_candidate_type: string | null;
      transport_protocol: string | null;
      relay_protocol: string | null;
    }>(`select * from call_browser_media_stats where call_id = $1`, [callId])
  ]);

  const lastReasonCode = [...events.rows].reverse().find((event) => event.reason_code)?.reason_code ?? null;
  const hangupCause = findHangupCause(events.rows);
  const timelineTotal = Number(events.rows[0]?.total_count ?? events.rows.length);
  const recordingStatus: CallDetailResponse["call"]["recordingStatus"] = !row.call_recording_enabled
    ? "disabled"
    : (row.call_recording_status ?? "pending");

  return {
    call: {
      id: row.id,
      leadName: row.lead_name ?? "Manual dial",
      agentName: row.agent_name ?? "Unassigned",
      phoneNumber: row.phone_number,
      campaignName: row.campaign_name ?? "No campaign",
      campaignId: row.campaign_id,
      agentId: row.agent_user_id,
      state: row.state,
      outcome: row.outcome,
      avmdReviewStatus:
        !row.avmd_attempted || !row.answered_at || !row.ended_at
          ? null
          : reviews.rows[0]?.actual_party === "uncertain"
            ? "uncertain"
            : reviews.rows[0]
              ? "reviewed"
              : "needs_review",
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      answeredAt: row.answered_at?.toISOString() ?? null,
      endedAt: row.ended_at?.toISOString() ?? null,
      manualDial: row.manual_dial,
      voicemailSignal: row.voicemail_signal_status,
      voicemailConfidence: row.voicemail_confidence === null ? null : Number(row.voicemail_confidence),
      avmdAttempted: row.avmd_attempted,
      recordingStatus,
      recordingDurationSeconds: row.call_recording_duration_seconds ?? null,
      recordingFileSizeBytes:
        row.call_recording_file_size_bytes === null || row.call_recording_file_size_bytes === undefined
          ? null
          : Number(row.call_recording_file_size_bytes),
      recordingIntegrityCheckedAt: row.call_recording_integrity_checked_at?.toISOString() ?? null,
      recordingFailureReason: row.call_recording_failure_reason ?? null,
      pcapStatus: row.pcap_status,
      pcapFileSizeBytes:
        row.pcap_file_size_bytes === null || row.pcap_file_size_bytes === undefined
          ? null
          : Number(row.pcap_file_size_bytes),
      pcapStartedAt: row.pcap_started_at?.toISOString() ?? null,
      pcapEndedAt: row.pcap_ended_at?.toISOString() ?? null,
      pcapFailureReason: row.pcap_failure_reason,
      pcapAvailable: row.pcap_status === "available" && Boolean(row.pcap_file_path),
      lastReasonCode,
      hangupCause,
      freeswitchTerminalAt: row.freeswitch_terminal_at?.toISOString() ?? null,
      terminalPersistedAt: row.terminal_persisted_at?.toISOString() ?? null,
      terminalSource: row.terminal_source,
      terminalEventName: row.terminal_event_name,
      finalizationLatencyMs: row.finalization_latency_ms,
      durationSeconds: row.duration_seconds ?? 0,
      recordingAvailable: recordingStatus === "available" && Boolean(row.call_recording_path)
    },
    avmdReview: reviews.rows[0]
      ? {
          actualParty: reviews.rows[0].actual_party,
          notes: reviews.rows[0].notes,
          reviewedByName: reviews.rows[0].reviewed_by_name,
          reviewedAt: reviews.rows[0].reviewed_at.toISOString(),
          updatedAt: reviews.rows[0].updated_at.toISOString()
        }
      : null,
    mediaQuality: mediaQuality.rows.map((media) => ({
      legType: media.leg_type,
      capturedAt: media.captured_at.toISOString(),
      readCodec: media.read_codec,
      writeCodec: media.write_codec,
      sipGateway: media.sip_gateway,
      sipProfile: media.sip_profile,
      inboundPacketCount: nullableNumber(media.inbound_packet_count),
      outboundPacketCount: nullableNumber(media.outbound_packet_count),
      inboundMediaPacketCount: nullableNumber(media.inbound_media_packet_count),
      outboundMediaPacketCount: nullableNumber(media.outbound_media_packet_count),
      inboundSkipPacketCount: nullableNumber(media.inbound_skip_packet_count),
      inboundJitterLossRate: nullableNumber(media.inbound_jitter_loss_rate),
      inboundJitterMaxVariance: nullableNumber(media.inbound_jitter_max_variance),
      inboundMos: nullableNumber(media.inbound_mos),
      inboundQualityPercentage: nullableNumber(media.inbound_quality_percentage),
      suspectedOneWayAudio: isSuspectedOneWayAudio(media, row.duration_seconds ?? 0)
    })),
    browserMedia: browserMedia.rows[0]
      ? {
          schemaVersion: browserMedia.rows[0].schema_version,
          startedAt: browserMedia.rows[0].started_at.toISOString(),
          endedAt: browserMedia.rows[0].ended_at.toISOString(),
          capturedAt: browserMedia.rows[0].captured_at.toISOString(),
          sampleCount: browserMedia.rows[0].sample_count,
          microphone: {
            sampleRate: browserMedia.rows[0].microphone_sample_rate,
            sampleSize: browserMedia.rows[0].microphone_sample_size,
            channelCount: browserMedia.rows[0].microphone_channel_count,
            echoCancellation: browserMedia.rows[0].microphone_echo_cancellation,
            noiseSuppression: browserMedia.rows[0].microphone_noise_suppression,
            autoGainControl: browserMedia.rows[0].microphone_auto_gain_control,
            latencySeconds: nullableNumber(browserMedia.rows[0].microphone_latency_seconds)
          },
          inbound: {
            codec: browserMedia.rows[0].inbound_codec,
            packetsReceived: nullableNumber(browserMedia.rows[0].inbound_packets_received),
            packetsLost: nullableNumber(browserMedia.rows[0].inbound_packets_lost),
            packetsDiscarded: nullableNumber(browserMedia.rows[0].inbound_packets_discarded),
            jitterSecondsMax: nullableNumber(browserMedia.rows[0].inbound_jitter_seconds_max),
            jitterBufferDelaySeconds: nullableNumber(
              browserMedia.rows[0].inbound_jitter_buffer_delay_seconds
            ),
            jitterBufferEmittedCount: nullableNumber(
              browserMedia.rows[0].inbound_jitter_buffer_emitted_count
            ),
            concealedSamples: nullableNumber(browserMedia.rows[0].inbound_concealed_samples),
            totalSamplesReceived: nullableNumber(browserMedia.rows[0].inbound_total_samples_received),
            concealmentEvents: nullableNumber(browserMedia.rows[0].inbound_concealment_events),
            audioEnergy: nullableNumber(browserMedia.rows[0].inbound_audio_energy),
            audioDurationSeconds: nullableNumber(browserMedia.rows[0].inbound_audio_duration_seconds)
          },
          outbound: {
            codec: browserMedia.rows[0].outbound_codec,
            packetsSent: nullableNumber(browserMedia.rows[0].outbound_packets_sent),
            bytesSent: nullableNumber(browserMedia.rows[0].outbound_bytes_sent),
            remotePacketsLost: nullableNumber(browserMedia.rows[0].outbound_remote_packets_lost),
            remoteJitterSecondsMax: nullableNumber(browserMedia.rows[0].outbound_remote_jitter_seconds_max),
            roundTripTimeSecondsMax: nullableNumber(browserMedia.rows[0].outbound_round_trip_time_seconds_max)
          },
          connection: {
            localCandidateType: browserMedia.rows[0].local_candidate_type,
            remoteCandidateType: browserMedia.rows[0].remote_candidate_type,
            protocol: browserMedia.rows[0].transport_protocol,
            relayProtocol: browserMedia.rows[0].relay_protocol
          }
        }
      : null,
    legs: legs.rows.map((leg) => {
      const legEvents = events.rows.filter((event) => eventBelongsToLeg(event, leg.freeswitch_uuid));
      return {
        type: leg.type,
        state: leg.state,
        freeswitchUuid: leg.freeswitch_uuid,
        sipUri: leg.sip_uri,
        startedAt: leg.started_at?.toISOString() ?? null,
        answeredAt: leg.answered_at?.toISOString() ?? null,
        endedAt: leg.ended_at?.toISOString() ?? null,
        hangupCause: findHangupCause(legEvents),
        reasonCode: [...legEvents].reverse().find((event) => event.reason_code)?.reason_code ?? null
      };
    }),
    timeline: events.rows.map((event) => ({
      at: event.created_at.toISOString(),
      eventType: event.event_type,
      state: event.state ?? "",
      label: humanize(event.event_type),
      reasonCode: event.reason_code,
      freeSwitchEventName: event.freeswitch_event_name,
      apiCommandName: event.api_command_name,
      agentLegUuid: event.agent_leg_uuid,
      customerLegUuid: event.customer_leg_uuid
    })),
    timelineTotal,
    timelineTruncated: timelineTotal > events.rows.length
  };
}

type CallDetailEventRow = {
  event_type: string;
  state: string | null;
  reason_code: string | null;
  freeswitch_event_name: string | null;
  api_command_name: string | null;
  agent_leg_uuid: string | null;
  customer_leg_uuid: string | null;
  raw_json: Record<string, unknown>;
  created_at: Date;
  total_count?: string | number;
};

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSuspectedOneWayAudio(
  media: {
    inbound_packet_count: string | number | null;
    outbound_packet_count: string | number | null;
    inbound_media_packet_count: string | number | null;
    outbound_media_packet_count: string | number | null;
  },
  durationSeconds: number
): boolean {
  const inbound =
    nullableNumber(media.inbound_media_packet_count) ?? nullableNumber(media.inbound_packet_count);
  const outbound =
    nullableNumber(media.outbound_media_packet_count) ?? nullableNumber(media.outbound_packet_count);
  return (
    durationSeconds >= 10 &&
    inbound !== null &&
    outbound !== null &&
    ((inbound <= 5 && outbound >= 50) || (outbound <= 5 && inbound >= 50))
  );
}

function eventBelongsToLeg(event: CallDetailEventRow, legUuid: string | null): boolean {
  if (!legUuid) return false;
  if (event.agent_leg_uuid === legUuid || event.customer_leg_uuid === legUuid) return true;
  const headers = event.raw_json?.headers;
  if (!headers || typeof headers !== "object") return false;
  return ["Unique-ID", "Channel-Call-UUID", "variable_uuid"].some(
    (key) => (headers as Record<string, unknown>)[key] === legUuid
  );
}

function findHangupCause(events: Array<{ raw_json: Record<string, unknown> }>): string | null {
  for (const event of [...events].reverse()) {
    const sources = [event.raw_json, event.raw_json?.headers].filter(
      (value): value is Record<string, unknown> => Boolean(value && typeof value === "object")
    );
    for (const source of sources) {
      for (const key of [
        "hangup-cause",
        "Hangup-Cause",
        "variable_hangup_cause",
        "variable_originate_disposition",
        "hangupCause"
      ]) {
        const value = source[key];
        if (typeof value === "string" && value.trim()) {
          return value;
        }
      }
    }
  }
  return null;
}

export async function getCallRecordingAudioFile(
  pool: pg.Pool,
  callId: string
): Promise<{ filePath: string } | null> {
  const result = await pool.query<{ call_recording_path: string | null }>(
    `
      select call_recording_path
      from calls
      where id = $1
        and call_recording_status = 'available'
      limit 1
    `,
    [callId]
  );
  const filePath = result.rows[0]?.call_recording_path;
  return filePath ? { filePath } : null;
}

async function getSuppression(pool: pg.Pool): Promise<AdminOverviewResponse["suppression"]> {
  const result = await pool.query<{
    id: string;
    phone_number: string;
    reason: string | null;
    created_at: Date;
  }>(`
    select id, phone_number, reason, created_at
    from suppression_entries
    order by created_at desc
    limit 20
  `);

  return result.rows.map((row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    reason: row.reason ?? "Suppressed",
    createdAt: row.created_at.toISOString()
  }));
}

export function mapCallStatus(state: CallState): NonNullable<AgentDeskResponse["activeCall"]>["status"] {
  if (
    state === "created" ||
    state === "agent_ringing" ||
    state === "agent_answered" ||
    state === "customer_dialing"
  ) {
    return "dialing";
  }
  if (state === "customer_ringing") {
    return "ringing";
  }
  if (state === "voicemail_drop_requested" || state === "voicemail_playback_started") {
    return "voicemail_drop";
  }
  if (state === "completed") {
    return "completed";
  }
  return "bridged";
}

export function mapVoicemailSignal(
  status: string | null
): NonNullable<AgentDeskResponse["activeCall"]>["voicemailSignal"] {
  if (status === "detected") {
    return "detected";
  }
  if (status === "possible") {
    return "possible";
  }
  return "none";
}

export function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function humanize(value: string): string {
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
