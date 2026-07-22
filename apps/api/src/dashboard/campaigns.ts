import type pg from "pg";
import type {
  AdminCampaignListResponse,
  AdminOverviewResponse,
  AgentDeskResponse
} from "@outbound-dialer/shared";

export type AgentCampaign = {
  id: string;
  name: string;
  status: "active" | "paused" | "draft";
  manual_dialing_enabled: boolean;
  call_recording_enabled: boolean;
  early_media_avmd_enabled: boolean;
  auto_advance_to_next_lead_enabled: boolean;
  callable_leads: string;
  agent_registered: boolean;
};

type AgentCampaignOptions = {
  allowFallback?: boolean;
  userId?: string;
  maxAttempts?: number;
  retryDelaySeconds?: number;
};

export type ContactRetryPolicy = { maxAttempts: number; retryDelaySeconds: number };

export type CampaignLibraryFilters = {
  page: number;
  pageSize: number;
  q?: string;
};

type CampaignOverviewRow = {
  id: string;
  name: string;
  status: AdminOverviewResponse["campaigns"][number]["status"];
  loaded: string;
  callable: string;
  attempted: string;
  outcome_distribution: Array<{ outcome: string; count: number }>;
  manual_dialing_enabled: boolean;
  call_recording_enabled: boolean;
  early_media_avmd_enabled: boolean;
  auto_advance_to_next_lead_enabled: boolean;
  total_count: string;
};

export async function deleteCampaign(
  pool: pg.Pool,
  campaignId: string
): Promise<"archived" | "not_found" | "active_call"> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const campaign = await client.query("select id from campaigns where id = $1 for update", [campaignId]);
    if (!campaign.rowCount) {
      await client.query("rollback");
      return "not_found";
    }

    const activeCalls = await client.query(
      `
        select 1
        from calls
        where campaign_id = $1
          and ended_at is null
          and state not in ('completed', 'failed', 'canceled')
        limit 1
      `,
      [campaignId]
    );
    if (activeCalls.rowCount) {
      await client.query("rollback");
      return "active_call";
    }

    await client.query("update campaigns set status = 'archived', updated_at = now() where id = $1", [
      campaignId
    ]);
    await client.query("commit");
    return "archived";
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function resetCampaignLeads(
  pool: pg.Pool,
  campaignId: string
): Promise<{ resetCount: number } | "not_found" | "active_call"> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const campaign = await client.query("select id from campaigns where id = $1 for update", [campaignId]);
    if (!campaign.rowCount) {
      await client.query("rollback");
      return "not_found";
    }

    const activeCalls = await client.query(
      `
        select 1
        from calls
        where campaign_id = $1
          and ended_at is null
          and state not in ('completed', 'failed', 'canceled')
        limit 1
      `,
      [campaignId]
    );
    if (activeCalls.rowCount) {
      await client.query("rollback");
      return "active_call";
    }

    const reset = await client.query(
      `
        update contacts
        set status = 'new',
            attempt_count = 0,
            last_attempted_at = null,
            updated_at = now()
        where campaign_id = $1
          and (
            status <> 'new'
            or attempt_count <> 0
            or last_attempted_at is not null
          )
      `,
      [campaignId]
    );
    await client.query("commit");
    return { resetCount: reset.rowCount ?? 0 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function campaignExists(pool: pg.Pool, campaignId: string): Promise<boolean> {
  const result = await pool.query("select 1 from campaigns where id = $1", [campaignId]);
  return Boolean(result.rowCount);
}

export async function getAgentCampaign(
  pool: pg.Pool,
  selectedCampaignId?: string,
  options: AgentCampaignOptions = {}
): Promise<AgentCampaign | null> {
  const result = await pool.query<AgentCampaign>(
    `
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      campaigns.manual_dialing_enabled,
      campaigns.call_recording_enabled,
      campaigns.early_media_avmd_enabled,
      campaigns.auto_advance_to_next_lead_enabled,
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
          and contacts.attempt_count < $4
          and (
            contacts.last_attempted_at is null
            or contacts.last_attempted_at <= now() - make_interval(secs => $5)
          )
      ) as callable_leads,
      exists (
        select 1
        from agents
        where agents.registered = true
          and ($3::uuid is null or agents.user_id = $3)
      ) as agent_registered
    from campaigns
    left join contacts on contacts.campaign_id = campaigns.id
    left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    where campaigns.status = 'active'
      and ($2::boolean = true or campaigns.id = $1)
    group by campaigns.id
    order by
      case when campaigns.id = $1 then 0 else 1 end,
      campaigns.created_at desc
    limit 1
  `,
    [
      selectedCampaignId ?? null,
      options.allowFallback ?? true,
      options.userId ?? null,
      options.maxAttempts ?? 2_147_483_647,
      options.retryDelaySeconds ?? 0
    ]
  );

  return result.rows[0] ?? null;
}

export async function getAgentCampaignForDialerAction(
  pool: pg.Pool,
  selectedCampaignId?: string,
  retryPolicy?: ContactRetryPolicy
): ReturnType<typeof getAgentCampaign> {
  if (!selectedCampaignId) {
    return getAgentCampaign(pool, undefined, retryPolicy);
  }
  return getAgentCampaign(pool, selectedCampaignId, { allowFallback: false, ...retryPolicy });
}

export async function getAgentCampaigns(
  pool: pg.Pool,
  retryPolicy?: ContactRetryPolicy
): Promise<AgentDeskResponse["availableCampaigns"]> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: "active" | "paused" | "draft";
    callable: string;
  }>(
    `
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
          and contacts.attempt_count < $1
          and (
            contacts.last_attempted_at is null
            or contacts.last_attempted_at <= now() - make_interval(secs => $2)
          )
      ) as callable
    from campaigns
    left join contacts on contacts.campaign_id = campaigns.id
    left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    where campaigns.status = 'active'
    group by campaigns.id
    order by campaigns.created_at desc
  `,
    [retryPolicy?.maxAttempts ?? 2_147_483_647, retryPolicy?.retryDelaySeconds ?? 0]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    callableLeads: Number(row.callable)
  }));
}

export async function getCampaigns(
  pool: pg.Pool,
  retryPolicy?: ContactRetryPolicy
): Promise<AdminOverviewResponse["campaigns"]> {
  return (await queryCampaignLibrary(pool, { limit: null, offset: 0 }, retryPolicy)).items;
}

export async function getCampaignsPage(
  pool: pg.Pool,
  filters: CampaignLibraryFilters,
  retryPolicy?: ContactRetryPolicy
): Promise<AdminCampaignListResponse> {
  const result = await queryCampaignLibrary(
    pool,
    {
      q: filters.q,
      limit: filters.pageSize,
      offset: (filters.page - 1) * filters.pageSize
    },
    retryPolicy
  );
  return {
    items: result.items,
    page: filters.page,
    pageSize: filters.pageSize,
    total: result.total,
    totalPages: result.total ? Math.ceil(result.total / filters.pageSize) : 0
  };
}

async function queryCampaignLibrary(
  pool: pg.Pool,
  filters: { q?: string; limit: number | null; offset: number },
  retryPolicy?: ContactRetryPolicy
): Promise<{ items: AdminOverviewResponse["campaigns"]; total: number }> {
  const q = filters.q?.trim() || null;
  const result = await pool.query<CampaignOverviewRow>(
    `
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      campaigns.manual_dialing_enabled,
      campaigns.call_recording_enabled,
      campaigns.early_media_avmd_enabled,
      campaigns.auto_advance_to_next_lead_enabled,
      count(contacts.id) as loaded,
      (select count(*) from calls where calls.campaign_id = campaigns.id) as attempted,
      coalesce((
        select jsonb_agg(
          jsonb_build_object('outcome', campaign_outcomes.outcome, 'count', campaign_outcomes.count)
          order by campaign_outcomes.count desc, campaign_outcomes.outcome asc
        )
        from (
          select coalesce(calls.outcome, 'pending') as outcome, count(*)::int as count
          from calls
          where calls.campaign_id = campaigns.id
          group by coalesce(calls.outcome, 'pending')
        ) campaign_outcomes
      ), '[]'::jsonb) as outcome_distribution,
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
          and contacts.attempt_count < $1
          and (
            contacts.last_attempted_at is null
            or contacts.last_attempted_at <= now() - make_interval(secs => $2)
          )
      ) as callable,
      count(*) over() as total_count
    from campaigns
    left join contacts on contacts.campaign_id = campaigns.id
    left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    where (
      $3::text is null
      or campaigns.name ilike '%' || $3 || '%'
      or campaigns.status::text ilike '%' || $3 || '%'
    )
    group by campaigns.id
    order by campaigns.created_at desc
    limit $4 offset $5
  `,
    [
      retryPolicy?.maxAttempts ?? 2_147_483_647,
      retryPolicy?.retryDelaySeconds ?? 0,
      q,
      filters.limit,
      filters.offset
    ]
  );

  return {
    items: result.rows.map(mapCampaignOverviewRow),
    total: Number(result.rows[0]?.total_count ?? 0)
  };
}

function mapCampaignOverviewRow(row: CampaignOverviewRow): AdminOverviewResponse["campaigns"][number] {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    loaded: Number(row.loaded),
    callable: Number(row.callable),
    attempted: Number(row.attempted ?? 0),
    outcomeDistribution: row.outcome_distribution ?? [],
    manualDialingEnabled: row.manual_dialing_enabled,
    callRecordingEnabled: row.call_recording_enabled,
    earlyMediaAvmdEnabled: row.early_media_avmd_enabled,
    autoAdvanceToNextLeadEnabled: row.auto_advance_to_next_lead_enabled
  };
}

export async function getCampaignOverviewItem(
  pool: pg.Pool,
  campaignId: string,
  retryPolicy?: ContactRetryPolicy
): Promise<AdminOverviewResponse["campaigns"][number] | null> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: AdminOverviewResponse["campaigns"][number]["status"];
    loaded: string;
    callable: string;
    attempted: string;
    outcome_distribution: Array<{ outcome: string; count: number }>;
    manual_dialing_enabled: boolean;
    call_recording_enabled: boolean;
    early_media_avmd_enabled: boolean;
    auto_advance_to_next_lead_enabled: boolean;
  }>(
    `
      select
        campaigns.id,
        campaigns.name,
        campaigns.status,
        campaigns.manual_dialing_enabled,
        campaigns.call_recording_enabled,
        campaigns.early_media_avmd_enabled,
        campaigns.auto_advance_to_next_lead_enabled,
        count(contacts.id) as loaded,
        (select count(*) from calls where calls.campaign_id = campaigns.id) as attempted,
        coalesce((
          select jsonb_agg(
            jsonb_build_object('outcome', campaign_outcomes.outcome, 'count', campaign_outcomes.count)
            order by campaign_outcomes.count desc, campaign_outcomes.outcome asc
          )
          from (
            select coalesce(calls.outcome, 'pending') as outcome, count(*)::int as count
            from calls
            where calls.campaign_id = campaigns.id
            group by coalesce(calls.outcome, 'pending')
          ) campaign_outcomes
        ), '[]'::jsonb) as outcome_distribution,
        count(contacts.id) filter (
          where contacts.status not in ('completed', 'suppressed')
            and suppression_entries.id is null
            and contacts.attempt_count < $2
            and (
              contacts.last_attempted_at is null
              or contacts.last_attempted_at <= now() - make_interval(secs => $3)
            )
        ) as callable
      from campaigns
      left join contacts on contacts.campaign_id = campaigns.id
      left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where campaigns.id = $1
      group by campaigns.id
    `,
    [campaignId, retryPolicy?.maxAttempts ?? 2_147_483_647, retryPolicy?.retryDelaySeconds ?? 0]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    loaded: Number(row.loaded),
    callable: Number(row.callable),
    attempted: Number(row.attempted ?? 0),
    outcomeDistribution: row.outcome_distribution ?? [],
    manualDialingEnabled: row.manual_dialing_enabled,
    callRecordingEnabled: row.call_recording_enabled,
    earlyMediaAvmdEnabled: row.early_media_avmd_enabled,
    autoAdvanceToNextLeadEnabled: row.auto_advance_to_next_lead_enabled
  };
}
