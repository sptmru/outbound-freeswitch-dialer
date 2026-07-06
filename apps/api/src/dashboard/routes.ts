import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  AdminOverviewResponse,
  AgentDeskResponse,
  CallOutcome,
  CallState,
  CreateCampaignRequest,
  CreateContactRequest,
  CreateSuppressionRequest,
  LeadSummary,
  ManualDialValidationResponse,
  MutationResponse,
  PublicUser
} from "@outbound-dialer/shared";
import { z } from "zod";
import { requireUser } from "../auth/routes.js";
import type { AppConfig } from "../config.js";
import { toPublicUser } from "../users.js";

const manualDialValidationSchema = z.object({
  phoneNumber: z.string().min(3)
});

const createCampaignSchema = z.object({
  name: z.string().min(1).max(160),
  status: z.enum(["active", "paused", "draft"]),
  manualDialingEnabled: z.boolean(),
  callRecordingEnabled: z.boolean()
}) satisfies z.ZodType<CreateCampaignRequest>;

const createContactSchema = z.object({
  campaignId: z.string().uuid(),
  name: z.string().min(1).max(160),
  phoneNumber: z.string().min(3).max(64),
  company: z.string().max(160).optional(),
  fields: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().max(400) })).max(20).optional()
}) satisfies z.ZodType<CreateContactRequest>;

const createSuppressionSchema = z.object({
  phoneNumber: z.string().min(3).max(64),
  reason: z.string().max(240).optional()
}) satisfies z.ZodType<CreateSuppressionRequest>;

export function registerDashboardRoutes(app: FastifyInstance, config: AppConfig, pool: pg.Pool): void {
  app.get("/agent/desk", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    return buildAgentDeskResponse(pool, toPublicUser(user));
  });

  app.get("/admin/overview", async (request, reply): Promise<AdminOverviewResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
    if (user.role !== "admin") {
      return reply.code(403).send({ message: "Admin role required" });
    }

    return buildAdminOverviewResponse(pool, toPublicUser(user));
  });

  app.post("/agent/manual-dial/validate", async (request, reply): Promise<ManualDialValidationResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const input = manualDialValidationSchema.parse(request.body);
    const normalizedNumber = normalizePhoneNumber(input.phoneNumber);
    const suppression = await findSuppression(pool, normalizedNumber);
    const hasEnoughDigits = normalizedNumber.length >= 12;
    const allowed = hasEnoughDigits && !suppression;

    return {
      normalizedNumber,
      allowed,
      reason: allowed
        ? "Number is callable"
        : suppression
          ? suppression.reason ?? "Number is suppressed"
          : "Enter at least 10 digits",
      checks: [
        {
          label: "Phone number",
          status: hasEnoughDigits ? "pass" : "fail",
          detail: hasEnoughDigits ? "Number has enough digits to dial" : "Enter at least 10 digits"
        },
        {
          label: "Suppression list",
          status: suppression ? "fail" : "pass",
          detail: suppression ? (suppression.reason ?? "Number is suppressed") : "No matching suppression entry"
        },
        {
          label: "Manual dialing",
          status: "pass",
          detail: "Allowed for this campaign"
        }
      ]
    };
  });

  app.post(
    "/admin/campaigns",
    async (request, reply): Promise<MutationResponse<AdminOverviewResponse["campaigns"][number]> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const input = createCampaignSchema.parse(request.body);
      const result = await pool.query<{
        id: string;
        name: string;
        status: string;
      }>(
        `
          insert into campaigns (name, status, manual_dialing_enabled, call_recording_enabled)
          values ($1, $2, $3, $4)
          returning id, name, status
        `,
        [input.name, input.status, input.manualDialingEnabled, input.callRecordingEnabled]
      );

      const row = result.rows[0];
      return reply.code(201).send({
        item: {
          id: row.id,
          name: row.name,
          status: row.status,
          loaded: 0,
          callable: 0
        }
      });
    }
  );

  app.post(
    "/admin/contacts",
    async (request, reply): Promise<MutationResponse<LeadSummary> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const input = createContactSchema.parse(request.body);
      const normalizedNumber = normalizePhoneNumber(input.phoneNumber);
      const mappedFields = Object.fromEntries((input.fields ?? []).map((field) => [field.label, field.value]));
      if (input.company) {
        mappedFields.Company = input.company;
      }

      const result = await pool.query<{
        id: string;
        display_name: string | null;
        phone_number: string;
        mapped_fields_json: Record<string, unknown>;
      }>(
        `
          insert into contacts (
            campaign_id,
            phone_number,
            normalized_phone_number,
            display_name,
            mapped_fields_json,
            status
          )
          values ($1, $2, $3, $4, $5::jsonb, 'new')
          returning id, display_name, phone_number, mapped_fields_json
        `,
        [input.campaignId, input.phoneNumber, normalizedNumber, input.name, JSON.stringify(mappedFields)]
      );

      const row = result.rows[0];
      const suppression = await findSuppression(pool, normalizedNumber);
      return reply.code(201).send({
        item: {
          id: row.id,
          name: row.display_name ?? input.name,
          company: String(row.mapped_fields_json.Company ?? row.mapped_fields_json.company ?? "Unmapped company"),
          phoneNumber: row.phone_number,
          status: suppression ? "suppressed" : "ready",
          fields: Object.entries(row.mapped_fields_json ?? {}).map(([label, value]) => ({
            label,
            value: String(value)
          }))
        }
      });
    }
  );

  app.post(
    "/admin/suppression",
    async (request, reply): Promise<MutationResponse<AdminOverviewResponse["suppression"][number]> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const input = createSuppressionSchema.parse(request.body);
      const normalizedNumber = normalizePhoneNumber(input.phoneNumber);
      const result = await pool.query<{
        id: string;
        phone_number: string;
        reason: string | null;
      }>(
        `
          insert into suppression_entries (phone_number, normalized_phone_number, reason, created_by_user_id)
          values ($1, $2, $3, $4)
          on conflict (normalized_phone_number)
          do update set reason = excluded.reason
          returning id, phone_number, reason
        `,
        [input.phoneNumber, normalizedNumber, input.reason ?? null, user.id]
      );

      const row = result.rows[0];
      return reply.code(201).send({
        item: {
          id: row.id,
          phoneNumber: row.phone_number,
          reason: row.reason ?? "Suppressed"
        }
      });
    }
  );
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  pool: pg.Pool
): Promise<PublicUser | null> {
  const user = await requireUser(request, config, pool);
  if (!user) {
    reply.code(401).send({ message: "Unauthorized" });
    return null;
  }
  if (user.role !== "admin") {
    reply.code(403).send({ message: "Admin role required" });
    return null;
  }
  return toPublicUser(user);
}

async function findSuppression(pool: pg.Pool, normalizedNumber: string): Promise<{ reason: string | null } | null> {
  const result = await pool.query<{ reason: string | null }>(
    "select reason from suppression_entries where normalized_phone_number = $1",
    [normalizedNumber]
  );
  return result.rows[0] ?? null;
}

async function buildAgentDeskResponse(pool: pg.Pool, user: PublicUser): Promise<AgentDeskResponse> {
  const campaign = await getActiveCampaign(pool);
  if (!campaign) {
    return buildDemoAgentDeskResponse(user);
  }

  const [leads, activeCall, metrics] = await Promise.all([
    getLeadQueue(pool, campaign.id),
    getActiveCall(pool, user.id),
    getAgentMetrics(pool, user.id)
  ]);

  return {
    user,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      callableLeads: Number(campaign.callable_leads),
      manualDialingEnabled: campaign.manual_dialing_enabled,
      callRecordingEnabled: campaign.call_recording_enabled
    },
    softphone: {
      registered: Boolean(campaign.agent_registered),
      microphoneAllowed: true,
      status: activeCall ? "in_call" : "ready"
    },
    metrics,
    leads: leads.length > 0 ? leads : buildDemoLeads(),
    activeCall
  };
}

async function buildAdminOverviewResponse(pool: pg.Pool, user: PublicUser): Promise<AdminOverviewResponse> {
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

async function getActiveCampaign(pool: pg.Pool): Promise<{
  id: string;
  name: string;
  status: "active" | "paused" | "draft";
  manual_dialing_enabled: boolean;
  call_recording_enabled: boolean;
  callable_leads: string;
  agent_registered: boolean;
} | null> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: "active" | "paused" | "draft";
    manual_dialing_enabled: boolean;
    call_recording_enabled: boolean;
    callable_leads: string;
    agent_registered: boolean;
  }>(`
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      campaigns.manual_dialing_enabled,
      campaigns.call_recording_enabled,
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
      ) as callable_leads,
      exists (
        select 1
        from agents
        where agents.status = 'registered'
      ) as agent_registered
    from campaigns
    left join contacts on contacts.campaign_id = campaigns.id
    left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    group by campaigns.id
    order by
      case campaigns.status
        when 'active' then 0
        when 'paused' then 1
        else 2
      end,
      campaigns.created_at desc
    limit 1
  `);

  return result.rows[0] ?? null;
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
    recording_name: string | null;
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
        recordings.name as recording_name
      from calls
      join agents on agents.id = calls.agent_id
      left join contacts on contacts.id = calls.contact_id
      left join recordings on recordings.id = calls.recording_id
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
    recordingName: row.recording_name ?? "No default recording",
    timeline: await getCallTimeline(pool, row.id)
  };
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

async function getCampaigns(pool: pg.Pool): Promise<AdminOverviewResponse["campaigns"]> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: string;
    loaded: string;
    callable: string;
  }>(`
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      count(contacts.id) as loaded,
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
      ) as callable
    from campaigns
    left join contacts on contacts.campaign_id = campaigns.id
    left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    group by campaigns.id
    order by campaigns.created_at desc
    limit 12
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    loaded: Number(row.loaded),
    callable: Number(row.callable)
  }));
}

async function getRecordings(pool: pg.Pool): Promise<AdminOverviewResponse["recordings"]> {
  const result = await pool.query<{
    id: string;
    name: string;
    is_default: boolean;
    is_active: boolean;
  }>(`
    select id, name, is_default, is_active
    from recordings
    order by is_default desc, created_at desc
    limit 12
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    durationSeconds: 0,
    status: row.is_default ? "default" : row.is_active ? "ready" : "inactive"
  }));
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
    outcome: CallOutcome | null;
    duration_seconds: number | null;
  }>(`
    select
      calls.id,
      contacts.display_name as lead_name,
      users.name as agent_name,
      calls.outcome,
      extract(epoch from (coalesce(calls.ended_at, now()) - coalesce(calls.answered_at, calls.started_at, calls.created_at)))::int as duration_seconds
    from calls
    left join contacts on contacts.id = calls.contact_id
    left join agents on agents.id = calls.agent_id
    left join users on users.id = agents.user_id
    order by calls.created_at desc
    limit 20
  `);

  return result.rows.map((row) => ({
    id: row.id,
    leadName: row.lead_name ?? "Manual dial",
    agentName: row.agent_name ?? "Unassigned",
    outcome: row.outcome ?? "failed",
    durationSeconds: row.duration_seconds ?? 0
  }));
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

function buildDemoAgentDeskResponse(user: PublicUser): AgentDeskResponse {
  return {
    user,
    campaign: {
      id: "campaign_demo_solar_followup",
      name: "Solar Follow-up",
      status: "active",
      callableLeads: 248,
      manualDialingEnabled: true,
      callRecordingEnabled: true
    },
    softphone: {
      registered: true,
      microphoneAllowed: true,
      status: "in_call"
    },
    metrics: {
      todayCalls: 37,
      voicemailsDropped: 11,
      suppressed: 4
    },
    leads: buildDemoLeads(),
    activeCall: {
      id: "call_demo_active",
      state: "bridged",
      leadName: "Avery Johnson",
      phoneNumber: "+1 415 555 0148",
      durationSeconds: 222,
      status: "bridged",
      voicemailSignal: "detected",
      recordingName: "Solar Intro v3",
      timeline: [
        { at: "00:00", label: "Agent leg answered" },
        { at: "00:18", label: "Customer leg answered" },
        { at: "00:21", label: "Bridge established" },
        { at: "00:24", label: "Call recording started" },
        { at: "03:37", label: "VM/beep signal detected" }
      ]
    }
  };
}

function buildDemoLeads(): LeadSummary[] {
  const leads = [
    {
      id: "lead_avery",
      name: "Avery Johnson",
      company: "North Bay Solar",
      phoneNumber: "+1 415 555 0148",
      status: "calling" as const,
      fields: [
        { label: "Company", value: "North Bay Solar" },
        { label: "Plan", value: "Residential retrofit" },
        { label: "Timezone", value: "America/Los_Angeles" },
        { label: "Last note", value: "Asked for callback after 2 PM" },
        { label: "CSV source", value: "july-solar-followups.csv" }
      ]
    },
    {
      id: "lead_morgan",
      name: "Morgan Lee",
      company: "Sunstone Homes",
      phoneNumber: "+1 628 555 0191",
      status: "ready" as const,
      fields: []
    },
    {
      id: "lead_taylor",
      name: "Taylor Brooks",
      company: "East Bay Roofing",
      phoneNumber: "+1 510 555 0172",
      status: "ready" as const,
      fields: []
    },
    {
      id: "lead_sam",
      name: "Sam Patel",
      company: "Harbor Lofts",
      phoneNumber: "+1 408 555 0120",
      status: "suppressed" as const,
      fields: []
    },
    {
      id: "lead_jordan",
      name: "Jordan Kim",
      company: "Greenline Design",
      phoneNumber: "+1 650 555 0184",
      status: "ready" as const,
      fields: []
    }
  ];

  return leads;
}

function mapCallStatus(state: CallState): NonNullable<AgentDeskResponse["activeCall"]>["status"] {
  if (state === "customer_dialing") {
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

function mapVoicemailSignal(status: string | null): NonNullable<AgentDeskResponse["activeCall"]>["voicemailSignal"] {
  if (status === "detected") {
    return "detected";
  }
  if (status === "possible") {
    return "possible";
  }
  return "none";
}

function formatElapsed(totalSeconds: number): string {
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

function normalizePhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
}
