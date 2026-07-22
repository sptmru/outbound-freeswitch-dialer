import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  AdminLiveCallsResponse,
  PublicUser,
  SoftphoneProvisioningResponse,
  SupervisorMode,
  SupervisorSession
} from "@outbound-dialer/shared";
import type { AppConfig } from "../config.js";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import { generateSecret, hashSecret } from "../auth/passwords.js";
import { parseRegisteredSipUsernames } from "../agent-registrations.js";
import { createFreeSwitchUuid, originateSupervisorEavesdrop, sendFreeSwitchApiCommand } from "../esl.js";
import { provisionAgentDirectory, reloadAgentDirectories } from "../freeswitch/provisioning.js";
import { lockUserMediaAction, lockUserMediaSession, unlockUserMediaSession } from "../user-media-lock.js";
import { buildSoftphoneIceServers } from "../users.js";

type SendApiCommand = typeof sendFreeSwitchApiCommand;
type OriginateSupervisor = typeof originateSupervisorEavesdrop;

interface SupervisorEndpointRow {
  user_id: string;
  sip_username: string;
  sip_password_encrypted: string;
  display_name: string;
}

interface SupervisorSessionRow {
  id: string;
  call_id: string;
  mode: SupervisorMode;
  state: SupervisorSession["state"];
  started_at: Date;
  connected_at: Date | null;
  ended_at: Date | null;
  failure_reason: string | null;
  supervisor_leg_uuid: string;
  updated_at: Date;
}

type Queryable = pg.Pool | pg.PoolClient;

interface MonitorableCallRow {
  id: string;
  state: string;
  ended_at: Date | null;
  agent_user_id: string | null;
  agent_leg_uuid: string | null;
  agent_leg_ended_at: Date | null;
  customer_leg_uuid: string | null;
  customer_leg_ended_at: Date | null;
}

export class SupervisorActionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409 | 502 | 503
  ) {
    super(message);
  }
}

export async function getSupervisorProvisioning(
  pool: pg.Pool,
  config: AppConfig,
  user: PublicUser
): Promise<SoftphoneProvisioningResponse> {
  const endpoint = await ensureSupervisorEndpoint(pool, config, user);
  const sipPassword = decryptSecret(config, endpoint.sip_password_encrypted);
  await provisionAgentDirectory(config, {
    sipUsername: endpoint.sip_username,
    sipPassword,
    displayName: endpoint.display_name
  });
  await reloadAgentDirectories(config);
  return {
    sipUri: `sip:${endpoint.sip_username}@${config.FREESWITCH_DOMAIN}`,
    sipUsername: endpoint.sip_username,
    sipPassword,
    displayName: endpoint.display_name,
    websocketUrl: config.FREESWITCH_WEBRTC_PUBLIC_WS_URL ?? `wss://${config.FREESWITCH_DOMAIN}/freeswitch-ws`,
    domain: config.FREESWITCH_DOMAIN,
    iceServers: buildSoftphoneIceServers(config, `supervisor:${user.id}`)
  };
}

async function ensureSupervisorEndpoint(
  pool: pg.Pool,
  config: AppConfig,
  user: PublicUser
): Promise<SupervisorEndpointRow> {
  const existing = await getSupervisorEndpoint(pool, user.id);
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sipUsername = `supervisor_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const collision = await pool.query(
      `select 1 from agents where sip_username = $1
       union all
       select 1 from admin_supervisor_endpoints where sip_username = $1
       limit 1`,
      [sipUsername]
    );
    if (collision.rowCount) continue;

    const sipPassword = generateSecret(24);
    try {
      const inserted = await pool.query<SupervisorEndpointRow>(
        `
          insert into admin_supervisor_endpoints (
            user_id,
            sip_username,
            sip_password_hash,
            sip_password_encrypted,
            display_name
          )
          values ($1, $2, $3, $4, $5)
          on conflict (user_id) do nothing
          returning user_id, sip_username, sip_password_encrypted, display_name
        `,
        [
          user.id,
          sipUsername,
          await hashSecret(sipPassword),
          encryptSecret(config, sipPassword),
          `${user.name} (supervisor)`
        ]
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const concurrent = await getSupervisorEndpoint(pool, user.id);
      if (concurrent) return concurrent;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error("Could not allocate a unique supervisor SIP identity");
}

async function getSupervisorEndpoint(pool: Queryable, userId: string): Promise<SupervisorEndpointRow | null> {
  const result = await pool.query<SupervisorEndpointRow>(
    `select user_id, sip_username, sip_password_encrypted, display_name
     from admin_supervisor_endpoints
     where user_id = $1
     limit 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function getAdminLiveCalls(pool: pg.Pool, actorUserId: string): Promise<AdminLiveCallsResponse> {
  const calls = await pool.query<{
    id: string;
    agent_name: string;
    lead_name: string | null;
    phone_number: string;
    campaign_name: string | null;
    state: AdminLiveCallsResponse["calls"][number]["state"];
    started_at: Date;
    answered_at: Date | null;
    active_supervisor_count: string;
    monitored_by_current_admin: boolean;
  }>(
    `
      select
        calls.id,
        agents.display_name as agent_name,
        contacts.display_name as lead_name,
        calls.destination_number as phone_number,
        campaigns.name as campaign_name,
        calls.state,
        coalesce(calls.started_at, calls.created_at) as started_at,
        calls.answered_at,
        count(supervisors.id)::text as active_supervisor_count,
        coalesce(bool_or(supervisors.actor_user_id = $1), false) as monitored_by_current_admin
      from calls
      join agents on agents.id = calls.agent_id
      join call_legs agent_leg
        on agent_leg.call_id = calls.id
       and agent_leg.type = 'agent'
       and agent_leg.freeswitch_uuid is not null
       and agent_leg.ended_at is null
      join call_legs customer_leg
        on customer_leg.call_id = calls.id
       and customer_leg.type = 'customer'
       and customer_leg.freeswitch_uuid is not null
       and customer_leg.ended_at is null
      left join contacts on contacts.id = calls.contact_id
      left join campaigns on campaigns.id = calls.campaign_id
      left join call_supervisor_sessions supervisors
        on supervisors.call_id = calls.id
       and supervisors.state in ('connecting', 'active')
      where calls.ended_at is null
        and calls.state in ('bridged', 'voicemail_signal_detected')
      group by calls.id, agents.display_name, contacts.display_name, campaigns.name
      order by coalesce(calls.started_at, calls.created_at) asc
    `,
    [actorUserId]
  );
  const active = await pool.query<SupervisorSessionRow>(
    `select id, call_id, mode, state, started_at, connected_at, ended_at, failure_reason, supervisor_leg_uuid, updated_at
     from call_supervisor_sessions
     where actor_user_id = $1
       and state in ('connecting', 'active')
     order by started_at desc
     limit 1`,
    [actorUserId]
  );
  const now = Date.now();
  return {
    calls: calls.rows.map((row) => ({
      id: row.id,
      agentName: row.agent_name,
      leadName: row.lead_name ?? "Manual dial",
      phoneNumber: row.phone_number,
      campaignName: row.campaign_name ?? "No campaign",
      state: row.state,
      startedAt: row.started_at.toISOString(),
      answeredAt: row.answered_at?.toISOString() ?? null,
      durationSeconds: Math.max(0, Math.floor((now - row.started_at.getTime()) / 1000)),
      activeSupervisorCount: Number(row.active_supervisor_count),
      monitoredByCurrentAdmin: row.monitored_by_current_admin
    })),
    activeSession: active.rows[0] ? mapSupervisorSession(active.rows[0]) : null
  };
}

export async function startSupervisorSession(
  pool: pg.Pool,
  config: AppConfig,
  input: { actorUserId: string; callId: string },
  dependencies: {
    createUuid?: typeof createFreeSwitchUuid;
    originate?: OriginateSupervisor;
    sendApiCommand?: SendApiCommand;
  } = {}
): Promise<SupervisorSession> {
  const sendApiCommand = dependencies.sendApiCommand ?? sendFreeSwitchApiCommand;
  const endpoint = await requireSupervisorEndpoint(pool, input.actorUserId);
  await requireSupervisorRegistration(config, endpoint.sip_username, sendApiCommand);
  const call = await requireMonitorableCall(pool, input.callId, input.actorUserId);
  await requireTargetChannels(config, call, sendApiCommand);

  const sessionId = randomUUID();
  const supervisorLegUuid = await (dependencies.createUuid ?? createFreeSwitchUuid)(config);
  let inserted: SupervisorSessionRow;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockUserMediaAction(client, input.actorUserId);
    const actor = await client.query(
      "select 1 from users where id = $1 and is_active = true and role = 'admin'",
      [input.actorUserId]
    );
    if (!actor.rowCount) {
      throw new SupervisorActionError("Administrator access changed; sign in again", 409);
    }
    const ownedActiveCall = await client.query(
      `select 1
       from calls
       join agents on agents.id = calls.agent_id
       where agents.user_id = $1
         and calls.ended_at is null
         and calls.state not in ('completed', 'failed', 'canceled', 'agent_released')
       limit 1`,
      [input.actorUserId]
    );
    if (ownedActiveCall.rowCount) {
      throw new SupervisorActionError("Finish your own Agent Desk call before monitoring another call", 409);
    }
    const result = await client.query<SupervisorSessionRow>(
      `
        insert into call_supervisor_sessions (
          id,
          call_id,
          actor_user_id,
          mode,
          state,
          supervisor_leg_uuid,
          target_agent_leg_uuid,
          target_customer_leg_uuid
        )
        values ($1, $2, $3, 'listen', 'connecting', $4, $5, $6)
        returning id, call_id, mode, state, started_at, connected_at, ended_at, failure_reason, supervisor_leg_uuid, updated_at
      `,
      [
        sessionId,
        input.callId,
        input.actorUserId,
        supervisorLegUuid,
        call.agent_leg_uuid,
        call.customer_leg_uuid
      ]
    );
    inserted = result.rows[0]!;
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    if (isUniqueViolation(error)) {
      throw new SupervisorActionError("Stop the current monitoring session before joining another call", 409);
    }
    throw error;
  } finally {
    client.release();
  }

  try {
    const originate = await (dependencies.originate ?? originateSupervisorEavesdrop)(config, {
      callId: input.callId,
      mode: "listen",
      sessionId,
      sipUsername: endpoint.sip_username,
      supervisorLegUuid,
      targetAgentLegUuid: call.agent_leg_uuid!
    });
    await pool.query(
      `update call_supervisor_sessions
       set originate_job_uuid = nullif($2, '')::uuid,
           updated_at = now()
       where id = $1`,
      [sessionId, originate.jobUuid]
    );
    return mapSupervisorSession(inserted);
  } catch (error) {
    await failSupervisorSession(pool, sessionId, error);
    throw new SupervisorActionError("FreeSWITCH could not start the supervisor connection", 502);
  }
}

export async function updateSupervisorSessionMode(
  pool: pg.Pool,
  config: AppConfig,
  input: { actorUserId: string; mode: SupervisorMode; sessionId: string },
  dependencies: {
    createUuid?: typeof createFreeSwitchUuid;
    originate?: OriginateSupervisor;
    sendApiCommand?: SendApiCommand;
  } = {}
): Promise<SupervisorSession> {
  const sendApiCommand = dependencies.sendApiCommand ?? sendFreeSwitchApiCommand;
  return withUserMediaSessionLock(pool, input.actorUserId, async (client) => {
    const current = await requireOwnedSupervisorSession(client, input.sessionId, input.actorUserId);
    if (current.state === "connecting") {
      throw new SupervisorActionError(
        "Wait for the current supervisor connection to finish connecting before changing mode",
        409
      );
    }
    if (current.mode === input.mode) return mapSupervisorSession(current);
    const endpoint = await requireSupervisorEndpoint(client, input.actorUserId);
    await requireSupervisorRegistration(config, endpoint.sip_username, sendApiCommand);
    const call = await requireMonitorableCall(client, current.call_id, input.actorUserId);
    await requireTargetChannels(config, call, sendApiCommand);

    const newLegUuid = await (dependencies.createUuid ?? createFreeSwitchUuid)(config);
    try {
      if (await freeSwitchUuidExists(config, current.supervisor_leg_uuid, sendApiCommand)) {
        await sendApiCommand(config, `uuid_kill ${current.supervisor_leg_uuid} NORMAL_CLEARING`);
      }
    } catch {
      throw new SupervisorActionError(
        "FreeSWITCH did not confirm the previous supervisor connection was stopped; its mode was not changed",
        502
      );
    }

    const updated = await client.query<SupervisorSessionRow>(
      `
        update call_supervisor_sessions
        set mode = $3,
            state = 'connecting',
            supervisor_leg_uuid = $4,
            originate_job_uuid = null,
            target_agent_leg_uuid = $5,
            target_customer_leg_uuid = $6,
            connected_at = null,
            ended_at = null,
            failure_reason = null,
            updated_at = now()
        where id = $1
          and actor_user_id = $2
          and state = 'active'
        returning id, call_id, mode, state, started_at, connected_at, ended_at, failure_reason, supervisor_leg_uuid, updated_at
      `,
      [
        input.sessionId,
        input.actorUserId,
        input.mode,
        newLegUuid,
        call.agent_leg_uuid,
        call.customer_leg_uuid
      ]
    );
    if (!updated.rows[0]) {
      throw new SupervisorActionError("Supervisor session is no longer active", 409);
    }

    try {
      const originate = await (dependencies.originate ?? originateSupervisorEavesdrop)(config, {
        callId: current.call_id,
        mode: input.mode,
        sessionId: input.sessionId,
        sipUsername: endpoint.sip_username,
        supervisorLegUuid: newLegUuid,
        targetAgentLegUuid: call.agent_leg_uuid!
      });
      await client.query(
        `update call_supervisor_sessions
         set originate_job_uuid = nullif($2, '')::uuid,
             updated_at = now()
         where id = $1
           and supervisor_leg_uuid = $3`,
        [input.sessionId, originate.jobUuid, newLegUuid]
      );
      return mapSupervisorSession(updated.rows[0]);
    } catch (error) {
      await failSupervisorSession(client, input.sessionId, error, newLegUuid);
      throw new SupervisorActionError("FreeSWITCH could not apply the supervisor mode", 502);
    }
  });
}

export async function stopSupervisorSession(
  pool: pg.Pool,
  config: AppConfig,
  input: { actorUserId: string; sessionId: string },
  sendApiCommand: SendApiCommand = sendFreeSwitchApiCommand
): Promise<void> {
  await withUserMediaSessionLock(pool, input.actorUserId, async (client) => {
    const current = await requireOwnedSupervisorSession(client, input.sessionId, input.actorUserId);
    let exists: boolean;
    try {
      exists = await freeSwitchUuidExists(config, current.supervisor_leg_uuid, sendApiCommand);
      if (current.state === "connecting" && !exists) {
        throw new SupervisorActionError(
          "Wait for the supervisor connection attempt to finish before stopping it",
          409
        );
      }
      if (exists) {
        await sendApiCommand(config, `uuid_kill ${current.supervisor_leg_uuid} NORMAL_CLEARING`);
      }
    } catch (error) {
      if (error instanceof SupervisorActionError) throw error;
      throw new SupervisorActionError(
        "FreeSWITCH did not confirm supervisor disconnection; the session remains marked active",
        502
      );
    }
    await client.query(
      `update call_supervisor_sessions
       set state = 'ended', ended_at = coalesce(ended_at, now()), updated_at = now()
       where id = $1 and actor_user_id = $2 and supervisor_leg_uuid = $3`,
      [input.sessionId, input.actorUserId, current.supervisor_leg_uuid]
    );
  });
}

export async function persistSupervisorFreeSwitchEvent(
  pool: pg.Pool,
  input: {
    eventName: string;
    sessionId: string;
    supervisorLegUuid: string | null;
    hangupCause?: string;
  }
): Promise<void> {
  if (!input.supervisorLegUuid) return;
  if (input.eventName === "CHANNEL_ANSWER" || input.eventName === "CHANNEL_BRIDGE") {
    await pool.query(
      `update call_supervisor_sessions
       set state = 'active', connected_at = coalesce(connected_at, now()), updated_at = now()
       where id = $1
         and supervisor_leg_uuid = $2
         and state = 'connecting'`,
      [input.sessionId, input.supervisorLegUuid]
    );
    return;
  }
  if (["CHANNEL_HANGUP", "CHANNEL_HANGUP_COMPLETE", "CHANNEL_DESTROY"].includes(input.eventName)) {
    await pool.query(
      `update call_supervisor_sessions
       set state = 'ended',
           ended_at = coalesce(ended_at, now()),
           failure_reason = case
             when $3::text is null or upper($3) in ('NORMAL_CLEARING', 'ORIGINATOR_CANCEL') then failure_reason
             else coalesce(failure_reason, left($3, 1000))
           end,
           updated_at = now()
       where id = $1
         and supervisor_leg_uuid = $2
         and state in ('connecting', 'active')`,
      [input.sessionId, input.supervisorLegUuid, input.hangupCause ?? null]
    );
  }
}

export async function persistSupervisorBackgroundJobFailure(
  pool: pg.Pool,
  jobUuid: string,
  error: string
): Promise<void> {
  await pool.query(
    `update call_supervisor_sessions
     set state = 'failed',
         ended_at = coalesce(ended_at, now()),
         failure_reason = left($2, 1000),
         updated_at = now()
     where originate_job_uuid = $1
       and state = 'connecting'`,
    [jobUuid, error]
  );
}

async function requireSupervisorEndpoint(
  pool: Queryable,
  actorUserId: string
): Promise<SupervisorEndpointRow> {
  const endpoint = await getSupervisorEndpoint(pool, actorUserId);
  if (!endpoint) {
    throw new SupervisorActionError("Supervisor phone is not provisioned in this browser", 409);
  }
  return endpoint;
}

async function requireSupervisorRegistration(
  config: AppConfig,
  sipUsername: string,
  sendApiCommand: SendApiCommand
): Promise<void> {
  if (!config.FREESWITCH_ESL_ENABLED) {
    throw new SupervisorActionError("FreeSWITCH call control is disabled", 503);
  }
  try {
    const response = await sendApiCommand(config, "sofia status profile internal-webrtc reg");
    if (!parseRegisteredSipUsernames(response.body || response.raw).includes(sipUsername)) {
      throw new SupervisorActionError("Wait for the supervisor phone to connect before monitoring", 409);
    }
  } catch (error) {
    if (error instanceof SupervisorActionError) throw error;
    throw new SupervisorActionError("Could not verify the supervisor phone registration", 503);
  }
}

async function requireMonitorableCall(
  pool: Queryable,
  callId: string,
  actorUserId: string
): Promise<MonitorableCallRow> {
  const result = await pool.query<MonitorableCallRow>(
    `
      select
        calls.id,
        calls.state,
        calls.ended_at,
        agents.user_id as agent_user_id,
        agent_leg.freeswitch_uuid as agent_leg_uuid,
        agent_leg.ended_at as agent_leg_ended_at,
        customer_leg.freeswitch_uuid as customer_leg_uuid,
        customer_leg.ended_at as customer_leg_ended_at
      from calls
      left join agents on agents.id = calls.agent_id
      left join call_legs agent_leg on agent_leg.call_id = calls.id and agent_leg.type = 'agent'
      left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
      where calls.id = $1
      limit 1
    `,
    [callId]
  );
  const call = result.rows[0];
  if (!call) throw new SupervisorActionError("Call not found", 404);
  if (call.agent_user_id === actorUserId) {
    throw new SupervisorActionError("You cannot monitor your own Agent Desk call", 409);
  }
  if (
    call.ended_at ||
    !["bridged", "voicemail_signal_detected"].includes(call.state) ||
    !call.agent_leg_uuid ||
    call.agent_leg_ended_at ||
    !call.customer_leg_uuid ||
    call.customer_leg_ended_at
  ) {
    throw new SupervisorActionError("Call is no longer available for live monitoring", 409);
  }
  return call;
}

async function requireTargetChannels(
  config: AppConfig,
  call: MonitorableCallRow,
  sendApiCommand: SendApiCommand
): Promise<void> {
  try {
    const [agentExists, customerExists] = await Promise.all([
      freeSwitchUuidExists(config, call.agent_leg_uuid!, sendApiCommand),
      freeSwitchUuidExists(config, call.customer_leg_uuid!, sendApiCommand)
    ]);
    if (!agentExists || !customerExists) {
      throw new SupervisorActionError("Call media is no longer active in FreeSWITCH", 409);
    }
  } catch (error) {
    if (error instanceof SupervisorActionError) throw error;
    throw new SupervisorActionError("Could not verify the live call in FreeSWITCH", 503);
  }
}

async function requireOwnedSupervisorSession(
  pool: Queryable,
  sessionId: string,
  actorUserId: string
): Promise<SupervisorSessionRow> {
  const result = await pool.query<SupervisorSessionRow>(
    `select id, call_id, mode, state, started_at, connected_at, ended_at, failure_reason, supervisor_leg_uuid, updated_at
     from call_supervisor_sessions
     where id = $1 and actor_user_id = $2
     limit 1`,
    [sessionId, actorUserId]
  );
  const session = result.rows[0];
  if (!session) throw new SupervisorActionError("Supervisor session not found", 404);
  if (!(["connecting", "active"] as const).includes(session.state as "connecting" | "active")) {
    throw new SupervisorActionError("Supervisor session is no longer active", 409);
  }
  return session;
}

async function freeSwitchUuidExists(
  config: AppConfig,
  uuid: string,
  sendApiCommand: SendApiCommand
): Promise<boolean> {
  const response = await sendApiCommand(config, `uuid_exists ${uuid}`);
  return response.body.trim().toLowerCase() === "true";
}

async function failSupervisorSession(
  pool: Queryable,
  sessionId: string,
  error: unknown,
  supervisorLegUuid?: string
): Promise<void> {
  await pool.query(
    `update call_supervisor_sessions
     set state = 'failed',
         ended_at = coalesce(ended_at, now()),
         failure_reason = left($2, 1000),
         updated_at = now()
     where id = $1
       and ($3::uuid is null or supervisor_leg_uuid = $3)`,
    [sessionId, error instanceof Error ? error.message : String(error), supervisorLegUuid ?? null]
  );
}

async function withUserMediaSessionLock<T>(
  pool: pg.Pool,
  actorUserId: string,
  action: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await lockUserMediaSession(client, actorUserId);
  } catch (error) {
    client.release(true);
    throw error;
  }
  let actionFailed = false;
  let actionError: unknown;
  let result: T | undefined;
  try {
    result = await action(client);
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }
  let unlockError: unknown;
  try {
    await unlockUserMediaSession(client, actorUserId);
    client.release();
  } catch (error) {
    unlockError = error;
    client.release(true);
  }
  if (actionFailed) throw actionError;
  if (unlockError) throw unlockError;
  return result as T;
}

function mapSupervisorSession(row: SupervisorSessionRow): SupervisorSession {
  return {
    id: row.id,
    callId: row.call_id,
    mode: row.mode,
    state: row.state,
    startedAt: row.started_at.toISOString(),
    connectedAt: row.connected_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    failureReason: row.failure_reason
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export const __testing = {
  freeSwitchUuidExists,
  mapSupervisorSession
};
