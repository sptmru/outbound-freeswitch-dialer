import type pg from "pg";
import type { AdminOverviewResponse, AgentDeskResponse } from "@outbound-dialer/shared";

export type AgentCampaign = {
  id: string;
  name: string;
  status: "active" | "paused" | "draft";
  manual_dialing_enabled: boolean;
  call_recording_enabled: boolean;
  early_media_avmd_enabled: boolean;
  callable_leads: string;
  agent_registered: boolean;
};

type AgentCampaignOptions = {
  allowFallback?: boolean;
  userId?: string;
};

export async function deleteCampaign(
  pool: pg.Pool,
  campaignId: string
): Promise<"deleted" | "not_found" | "active_call"> {
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

    await client.query("update calls set contact_id = null where contact_id in (select id from contacts where campaign_id = $1)", [
      campaignId
    ]);
    await client.query("update calls set campaign_id = null where campaign_id = $1", [campaignId]);
    await client.query("delete from campaigns where id = $1", [campaignId]);
    await client.query("commit");
    return "deleted";
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
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
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
    [selectedCampaignId ?? null, options.allowFallback ?? true, options.userId ?? null]
  );

  return result.rows[0] ?? null;
}

export async function getAgentCampaignForDialerAction(
  pool: pg.Pool,
  selectedCampaignId?: string
): ReturnType<typeof getAgentCampaign> {
  if (!selectedCampaignId) {
    return getAgentCampaign(pool);
  }
  return getAgentCampaign(pool, selectedCampaignId, { allowFallback: false });
}

export async function getAgentCampaigns(pool: pg.Pool): Promise<AgentDeskResponse["availableCampaigns"]> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: "active" | "paused" | "draft";
    callable: string;
  }>(`
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
      ) as callable
    from campaigns
    left join contacts on contacts.campaign_id = campaigns.id
    left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    where campaigns.status = 'active'
    group by campaigns.id
    order by campaigns.created_at desc
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    callableLeads: Number(row.callable)
  }));
}

export async function getCampaigns(pool: pg.Pool): Promise<AdminOverviewResponse["campaigns"]> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: AdminOverviewResponse["campaigns"][number]["status"];
    loaded: string;
    callable: string;
    early_media_avmd_enabled: boolean;
  }>(`
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      campaigns.early_media_avmd_enabled,
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
    callable: Number(row.callable),
    earlyMediaAvmdEnabled: row.early_media_avmd_enabled
  }));
}

export async function getCampaignOverviewItem(
  pool: pg.Pool,
  campaignId: string
): Promise<AdminOverviewResponse["campaigns"][number] | null> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: AdminOverviewResponse["campaigns"][number]["status"];
    loaded: string;
    callable: string;
    early_media_avmd_enabled: boolean;
  }>(
    `
      select
        campaigns.id,
        campaigns.name,
        campaigns.status,
        campaigns.early_media_avmd_enabled,
        count(contacts.id) as loaded,
        count(contacts.id) filter (
          where contacts.status not in ('completed', 'suppressed')
            and suppression_entries.id is null
        ) as callable
      from campaigns
      left join contacts on contacts.campaign_id = campaigns.id
      left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where campaigns.id = $1
      group by campaigns.id
    `,
    [campaignId]
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
    earlyMediaAvmdEnabled: row.early_media_avmd_enabled
  };
}
