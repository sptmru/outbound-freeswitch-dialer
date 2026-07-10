import type pg from "pg";
import type {
  AdminOverviewResponse,
  AgentDeskResponse,
  CallActionAvailability,
  CallDetailResponse,
  CallOutcome,
  CallState,
  LeadSummary,
  PublicUser
} from "@outbound-dialer/shared";
import { getAgentCampaign, getAgentCampaigns, getCampaigns } from "./campaigns.js";
import { getRecordings } from "./recordings.js";

export async function buildAgentDeskResponse(
  pool: pg.Pool,
  user: PublicUser,
  selectedCampaignId?: string
): Promise<AgentDeskResponse> {
  const [campaign, availableCampaigns, activeCall, metrics, recordings] = await Promise.all([
    getAgentCampaign(pool, selectedCampaignId, { userId: user.id }),
    getAgentCampaigns(pool),
    getActiveCall(pool, user.id),
    getAgentMetrics(pool, user.id),
    getRecordings(pool)
  ]);
  const agentRecordings = recordings.map(({ id, name, status }) => ({ id, name, status }));
  if (!campaign) {
    return {
      user,
      campaign: null,
      availableCampaigns,
      softphone: {
        registered: false,
        microphoneAllowed: true,
        status: activeCall ? "in_call" : "offline"
      },
      metrics,
      leads: [],
      recordings: agentRecordings,
      activeCall
    };
  }

  const leads = await getLeadQueue(pool, campaign.id);

  return {
    user,
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
    leads,
    recordings: agentRecordings,
    activeCall
  };
}

export async function buildAdminOverviewResponse(pool: pg.Pool, user: PublicUser): Promise<AdminOverviewResponse> {
  const [stats, campaigns, recordings, users, callHistory, suppression] = await Promise.all([
    getAdminStats(pool),
    getCampaigns(pool),
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

async function getLeadQueue(pool: pg.Pool, campaignId: string): Promise<LeadSummary[]> {
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
          else 'ready'
        end as status
      from contacts
      left join suppression_entries
        on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where contacts.campaign_id = $1
      order by contacts.created_at asc
      limit 25
    `,
    [campaignId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.display_name ?? "Unknown contact",
    company: row.company ?? "Unmapped company",
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
        recordings.name as recording_name,
        customer_leg.freeswitch_uuid as customer_leg_uuid
      from calls
      join agents on agents.id = calls.agent_id
      left join contacts on contacts.id = calls.contact_id
      left join recordings on recordings.id = calls.recording_id
      left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
      where agents.user_id = $1
        and calls.ended_at is null
        and calls.state not in ('completed', 'failed', 'canceled')
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

function getCustomerMediaActionAvailability(state: CallState, customerLegUuid: string | null): CallActionAvailability {
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

async function getAdminStats(pool: pg.Pool): Promise<AdminOverviewResponse["stats"]> {
  const result = await pool.query<{
    campaigns: string;
    active_agents: string;
    calls_today: string;
    suppression_entries: string;
    live_calls: string;
  }>(`
    select
      (select count(*) from campaigns) as campaigns,
      (select count(*) from agents where status in ('ready', 'registered', 'in_call')) as active_agents,
      (select count(*) from calls where created_at >= date_trunc('day', now())) as calls_today,
      (select count(*) from suppression_entries) as suppression_entries,
      (select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled')) as live_calls
  `);
  const row = result.rows[0];

  return {
    campaigns: Number(row?.campaigns ?? 0),
    activeAgents: Number(row?.active_agents ?? 0),
    callsToday: Number(row?.calls_today ?? 0),
    suppressionEntries: Number(row?.suppression_entries ?? 0),
    liveCalls: Number(row?.live_calls ?? 0)
  };
}

async function getUsers(pool: pg.Pool): Promise<PublicUser[]> {
  const result = await pool.query<PublicUser>(`
    select id, email, name, role
    from users
    order by created_at desc
    limit 24
  `);
  return result.rows;
}

async function getCallHistory(pool: pg.Pool): Promise<AdminOverviewResponse["callHistory"]> {
  const result = await pool.query<{
    id: string;
    lead_name: string | null;
    agent_name: string | null;
    phone_number: string;
    campaign_name: string | null;
    state: CallState;
    outcome: CallOutcome | null;
    created_at: Date;
    duration_seconds: number | null;
    call_recording_path: string | null;
  }>(`
    select
      calls.id,
      contacts.display_name as lead_name,
      users.name as agent_name,
      calls.destination_number as phone_number,
      campaigns.name as campaign_name,
      calls.state,
      calls.outcome,
      calls.created_at,
      calls.call_recording_path,
      extract(epoch from (coalesce(calls.ended_at, now()) - coalesce(calls.answered_at, calls.started_at, calls.created_at)))::int as duration_seconds
    from calls
    left join contacts on contacts.id = calls.contact_id
    left join agents on agents.id = calls.agent_id
    left join users on users.id = agents.user_id
    left join campaigns on campaigns.id = calls.campaign_id
    order by calls.created_at desc
    limit 20
  `);

  return result.rows.map((row) => ({
    id: row.id,
    leadName: row.lead_name ?? "Manual dial",
    agentName: row.agent_name ?? "Unassigned",
    phoneNumber: row.phone_number,
    campaignName: row.campaign_name ?? "No campaign",
    state: row.state,
    outcome: row.outcome,
    createdAt: row.created_at.toISOString(),
    durationSeconds: row.duration_seconds ?? 0,
    callRecordingPath: row.call_recording_path
  }));
}

export async function getCallDetail(pool: pg.Pool, callId: string): Promise<CallDetailResponse | null> {
  const result = await pool.query<{
    id: string;
    lead_name: string | null;
    agent_name: string | null;
    phone_number: string;
    campaign_name: string | null;
    state: CallState;
    outcome: CallOutcome | null;
    created_at: Date;
    started_at: Date | null;
    answered_at: Date | null;
    ended_at: Date | null;
    manual_dial: boolean;
    duration_seconds: number | null;
    call_recording_path: string | null;
  }>(
    `
      select
        calls.id,
        contacts.display_name as lead_name,
        users.name as agent_name,
        calls.destination_number as phone_number,
        campaigns.name as campaign_name,
        calls.state,
        calls.outcome,
        calls.created_at,
        calls.started_at,
        calls.answered_at,
        calls.ended_at,
        calls.manual_dial,
        calls.call_recording_path,
        extract(epoch from (coalesce(calls.ended_at, now()) - coalesce(calls.answered_at, calls.started_at, calls.created_at)))::int as duration_seconds
      from calls
      left join contacts on contacts.id = calls.contact_id
      left join agents on agents.id = calls.agent_id
      left join users on users.id = agents.user_id
      left join campaigns on campaigns.id = calls.campaign_id
      where calls.id = $1
      limit 1
    `,
    [callId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const events = await pool.query<{ event_type: string; state: string; created_at: Date }>(
    `
      select event_type, state, created_at
      from call_events
      where call_id = $1
      order by created_at asc
      limit 100
    `,
    [callId]
  );

  return {
    call: {
      id: row.id,
      leadName: row.lead_name ?? "Manual dial",
      agentName: row.agent_name ?? "Unassigned",
      phoneNumber: row.phone_number,
      campaignName: row.campaign_name ?? "No campaign",
      state: row.state,
      outcome: row.outcome,
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      answeredAt: row.answered_at?.toISOString() ?? null,
      endedAt: row.ended_at?.toISOString() ?? null,
      manualDial: row.manual_dial,
      durationSeconds: row.duration_seconds ?? 0,
      callRecordingPath: row.call_recording_path
    },
    timeline: events.rows.map((event) => ({
      at: event.created_at.toISOString(),
      eventType: event.event_type,
      state: event.state,
      label: humanize(event.event_type)
    }))
  };
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
  }>(`
    select id, phone_number, reason
    from suppression_entries
    order by created_at desc
    limit 20
  `);

  return result.rows.map((row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    reason: row.reason ?? "Suppressed"
  }));
}

export function mapCallStatus(state: CallState): NonNullable<AgentDeskResponse["activeCall"]>["status"] {
  if (state === "created" || state === "agent_ringing" || state === "agent_answered" || state === "customer_dialing") {
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

export function mapVoicemailSignal(status: string | null): NonNullable<AgentDeskResponse["activeCall"]>["voicemailSignal"] {
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
