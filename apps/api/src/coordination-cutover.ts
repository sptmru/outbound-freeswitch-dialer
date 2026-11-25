import type pg from "pg";
import type { AppConfig } from "./config.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import { ingressRequest } from "./ingress-agent.js";
import { ingressUuid } from "./ingress-journal.js";

export async function checkCutoverDatabase(db: pg.Pool | pg.PoolClient) {
  const {
    rows: [state]
  } = await db.query<{ blocker: string | null }>(
    `select case
      when not exists(select 1 from system_settings where key='ops.call_start_paused' and value_json='true') then 'call starts are open'
      when exists(select 1 from inbound_numbers where enabled) then 'an inbound number is enabled'
      when exists(select 1 from calls where ended_at is null and state not in ('completed','failed','canceled')) then 'calls remain open'
      when exists(select 1 from call_legs where ended_at is null and freeswitch_uuid is not null
        and state not in ('completed','failed','canceled','ended','hangup','released')) then 'call legs remain open'
      when exists(select 1 from call_supervisor_sessions where ended_at is null or state in ('connecting','active')) then 'supervisor sessions remain open'
      when exists(select 1 from call_operations where resolved_at is null) then 'unresolved call operations'
      when exists(select 1 from call_transfers where closed_at is null) then 'transfers remain open'
      when exists(select 1 from call_offers where state='pending') then 'call offers remain open'
      when exists(select 1 from agent_call_slots where state<>'free'
        and (not reconciliation_required or participant_id is not null)) then 'occupied coordinated slots'
      when exists(select 1 from call_capacity_reservations where state<>'released' and origin<>'legacy_backfill') then 'unreleased coordinated capacity'
      when exists(select 1 from inbound_ingress_evidence where acknowledged_sequence<imported_sequence) then 'unacknowledged ingress records'
      when exists(select 1 from call_command_fences f where not exists(
        select 1 from call_command_receipt_acks a where a.operation_id=f.operation_id)) then 'unacknowledged native command receipts'
      end as blocker`
  );
  if (state?.blocker) throw new Error(`Call coordination cutover blocked: ${state.blocker}`);
}

export async function checkCutoverSwitch(config: AppConfig) {
  if (!config.FREESWITCH_ESL_ENABLED) throw new Error("Call coordination cutover requires ESL");
  const command = async (value: string) => (await sendFreeSwitchApiCommand(config, value, 2000)).body.trim();
  const core = await command("global_getvar core_uuid");
  const channels = JSON.parse(await command("show channels as json"));
  if (
    !ingressUuid.test(core) ||
    channels.row_count !== 0 ||
    (channels.rows !== undefined && (!Array.isArray(channels.rows) || channels.rows.length !== 0)) ||
    core !== (await command("global_getvar core_uuid"))
  ) {
    throw new Error(
      "Call coordination cutover requires a stable FreeSWITCH incarnation with no live channels"
    );
  }
  const dialplan = await command("xml_locate dialplan context name public");
  if (!dialplan.includes('name="public"') || dialplan.includes("outbound-ingress.lua"))
    throw new Error(
      "Call coordination cutover requires a verified FreeSWITCH dialplan with all inbound routes disabled"
    );
  return core;
}

export async function checkCutoverJournal(config: AppConfig) {
  const status = JSON.parse(await ingressRequest(config.FREESWITCH_INGRESS_SOCKET, "/status"));
  if (!ingressUuid.test(status.journalId ?? "") || status.used !== 0 || status.unacknowledged !== 0)
    throw new Error("Call coordination cutover requires an available, drained ingress journal");
}

export async function finishCallCoordinationCutover(pool: pg.Pool, activate: boolean) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='2s'");
    await client.query("select 1 from system_settings where key='ops.call_start_paused' for update");
    await client.query("lock table agents,inbound_numbers in share row exclusive mode");
    await checkCutoverDatabase(client);
    // Only the offline procedure calls this function after fencing the legacy
    // producers and proving the switch empty. Native ownership must be drained.
    if (activate) {
      await client.query(`update agent_call_slots set state='free',call_id=null,
        reservation_id=null,reconciliation_required=false where reconciliation_required`);
      await client.query(`update call_capacity_reservations set state='released',released_at=clock_timestamp()
        where origin='legacy_backfill' and state<>'released'`);
    }
    await client.query(`update agent_desk_sessions set ready=false,revoked_at=clock_timestamp(),revision=revision+1
      where revoked_at is null`);
    await client.query(`update agent_auto_next_intents set state='canceled',reason='coordination_cutover',
      closed_at=clock_timestamp() where closed_at is null`);
    const marker = await client.query(
      `update call_admission_migration set reconciliation_required=not $1::boolean,
      reconciled_at=case when $1 then clock_timestamp() else null end where singleton`,
      [activate]
    );
    if (marker.rowCount !== 1) throw new Error("Call admission cutover marker is missing");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
