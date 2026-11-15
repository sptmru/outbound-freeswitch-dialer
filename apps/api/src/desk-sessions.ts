import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  CreateDeskSessionRequest,
  DeskMutationRequest,
  DeskSessionResponse,
  UpdateDeskSessionRequest
} from "@outbound-dialer/shared";
import type { AppConfig } from "./config.js";
import { buildSoftphoneIceServers } from "./users.js";
import { decryptSecret, encryptSecret } from "./auth/crypto.js";
import { AdmissionError } from "./call-admission.js";
import { cancelPendingAgentWork, lockEligibilityAgents, withEligibilityTransaction } from "./eligibility.js";
import { requestFingerprint } from "./call-coordination-contracts.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import {
  deleteAgentDirectory,
  provisionAgentDirectory,
  refreshDeletedAgentRegistrations,
  reloadAgentDirectories
} from "./freeswitch/provisioning.js";

export const DESK_LEASE_SECONDS = 30;
export const DESK_VERIFICATION_SECONDS = 15;
export interface DeskActor {
  userId: string;
  authVersion: number;
  agentId: string;
}
export type DeskSessionResult = DeskSessionResponse;
interface DeskRow extends pg.QueryResultRow {
  id: string;
  agent_id: string;
  campaign_id: string | null;
  revision: string;
  binding_generation: string;
  sip_username: string;
  sip_secret_encrypted: string;
  verified_endpoint: string | null;
  endpoint_pin: string | null;
  ready: boolean;
  expires_at: Date;
  revoked_at: Date | null;
  actor_auth_version: number;
}
export interface DeskTelephony {
  provision(username: string, password: string): Promise<void>;
  lookup(username: string): Promise<string>;
  remove(username: string): Promise<void>;
}
export function deskTelephony(config: AppConfig): DeskTelephony {
  return {
    async provision(username, password) {
      if (!config.FREESWITCH_ESL_ENABLED || !/^desk_[a-f0-9]{32}$/.test(username))
        throw new AdmissionError("endpoint_unavailable");
      await provisionAgentDirectory(config, {
        sipUsername: username,
        sipPassword: password,
        displayName: "Agent Desk"
      });
      await reloadAgentDirectories(config);
    },
    async lookup(username) {
      if (
        !config.FREESWITCH_ESL_ENABLED ||
        !/^desk_[a-f0-9]{32}$/.test(username) ||
        !/^[a-zA-Z0-9_.-]+$/.test(config.FREESWITCH_DOMAIN)
      )
        return "";
      const response = await sendFreeSwitchApiCommand(
        config,
        `sofia_contact internal-webrtc/${username}@${config.FREESWITCH_DOMAIN}`
      );
      return response.body || response.raw;
    },
    async remove(username) {
      if (!config.FREESWITCH_ESL_ENABLED || !/^desk_[a-f0-9]{32}$/.test(username))
        throw new AdmissionError("endpoint_unavailable");
      await deleteAgentDirectory(config, username);
      const result = await refreshDeletedAgentRegistrations(config, [username]);
      if (result.skipped || result.errors.length) throw new AdmissionError("endpoint_unavailable");
    }
  };
}
/** Strict single FS contact, never a browser destination or an originate expression.
 * Accept WSS NAT contact parameters but reject multi-contact/API/dial-string syntax. */
export function verifiedDeskContact(value: string, username: string): string | null {
  if (!/^desk_[a-f0-9]{32}$/.test(username)) return null;
  const contact = value.trim();
  const host = "(?:[a-zA-Z0-9.-]+|\\[[a-fA-F0-9:]+\\])(?::[0-9]{1,5})?";
  const uri = `sips?:${username}@${host}(?:;[a-zA-Z0-9_.=-]+)*`;
  const pattern = new RegExp(
    `^sofia/internal-webrtc/${uri}(?:;fs_path=(?:[a-zA-Z0-9_.-]|%[a-fA-F0-9]{2})+)?$`
  );
  if (contact.length > 2048 || !pattern.test(contact)) return null;
  const encodedPath = contact.match(/;fs_path=([^;]+)$/)?.[1];
  if (encodedPath) {
    try {
      if (!new RegExp(`^${uri}$`).test(decodeURIComponent(encodedPath))) return null;
    } catch {
      return null;
    }
  }
  return contact;
}
function snapshot(row: DeskRow): DeskSessionResponse {
  return {
    revision: row.revision,
    session: {
      id: row.id,
      revision: row.revision,
      bindingGeneration: row.binding_generation,
      campaignId: row.campaign_id,
      endpointVerified: Boolean(row.verified_endpoint),
      ready: row.ready,
      expiresAt: row.expires_at.toISOString()
    }
  };
}
async function authenticate(client: pg.PoolClient, actor: DeskActor) {
  const result = await client.query(
    `select 1 from agents a join users u on u.id=a.user_id
    where a.id=$1 and u.id=$2 and u.is_active and u.auth_version=$3`,
    [actor.agentId, actor.userId, actor.authVersion]
  );
  if (!result.rowCount) throw new AdmissionError("session_revoked");
}
async function campaignLock(client: pg.PoolClient, campaignId: string | null) {
  if (
    campaignId &&
    !(await client.query("select id from campaigns where id=$1 and status='active' for share", [campaignId]))
      .rowCount
  )
    throw new AdmissionError("campaign_unavailable");
}
async function replay(
  client: pg.PoolClient,
  actor: DeskActor,
  key: string,
  fingerprint: string
): Promise<DeskSessionResponse | null> {
  const row = (
    await client.query("select * from agent_desk_mutations where agent_id=$1 and idempotency_key=$2", [
      actor.agentId,
      key
    ])
  ).rows[0];
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new AdmissionError("idempotency_conflict");
  return row.result;
}
async function remember(
  client: pg.PoolClient,
  actor: DeskActor,
  key: string,
  fingerprint: string,
  result: DeskSessionResponse
) {
  await client.query(
    "insert into agent_desk_mutations(agent_id,idempotency_key,fingerprint,result) values($1,$2,$3,$4)",
    [actor.agentId, key, fingerprint, JSON.stringify(result)]
  );
  return result;
}
export class DeskSessions {
  constructor(
    readonly pool: pg.Pool,
    readonly config: AppConfig,
    readonly telephony = deskTelephony(config)
  ) {}

  async create(actor: DeskActor, input: CreateDeskSessionRequest): Promise<DeskSessionResult> {
    const fingerprint = requestFingerprint("POST", "/agent/desk-sessions", actor.agentId, input);
    const result = await withEligibilityTransaction(this.pool, async (client) => {
      await campaignLock(client, input.campaignId);
      await lockEligibilityAgents(client, [actor.agentId]);
      await authenticate(client, actor);
      const previous = await replay(client, actor, input.idempotencyKey, fingerprint);
      if (previous) return previous;
      const slot = (await client.query("select * from agent_call_slots where agent_id=$1", [actor.agentId]))
        .rows[0];
      if (!slot || slot.reconciliation_required) throw new AdmissionError("coordination_unavailable");
      if (
        slot.state !== "free" ||
        (
          await client.query(
            `select 1 from calls where agent_id=$1 and ended_at is null and agent_released_at is null
        and state not in ('completed','failed','canceled','agent_released') union all
        select 1 from call_supervisor_sessions where actor_user_id=$2 and state in ('connecting','active')`,
            [actor.agentId, actor.userId]
          )
        ).rowCount
      )
        throw new AdmissionError("slot_occupied");
      const current = (
        await client.query<DeskRow>(
          "select * from agent_desk_sessions where agent_id=$1 and revoked_at is null for update",
          [actor.agentId]
        )
      ).rows[0];
      if ((current?.revision ?? null) !== input.expectedRevision)
        throw new AdmissionError("revision_conflict");
      // Monotonic across leave/reenter as well as takeover; no revision ABA.
      const latest = (
        await client.query(
          "select coalesce(max(binding_generation),0)+1 as generation,coalesce(max(revision),0)+1 as revision from agent_desk_sessions where agent_id=$1",
          [actor.agentId]
        )
      ).rows[0];
      await client.query(
        `update agent_desk_sessions set ready=false,revoked_at=clock_timestamp(),revision=revision+1 where agent_id=$1 and revoked_at is null`,
        [actor.agentId]
      );
      await cancelPendingAgentWork(client, [actor.agentId], "desk_controller_changed");
      const row = (
        await client.query<DeskRow>(
          `insert into agent_desk_sessions(id,agent_id,campaign_id,revision,binding_generation,sip_username,sip_secret_encrypted,actor_auth_version,expires_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '30 seconds') returning *`,
          [
            randomUUID(),
            actor.agentId,
            input.campaignId,
            latest.revision,
            latest.generation,
            `desk_${randomUUID().replaceAll("-", "")}`,
            encryptSecret(this.config, randomBytes(24).toString("base64url")),
            actor.authVersion
          ]
        )
      ).rows[0]!;
      return remember(client, actor, input.idempotencyKey, fingerprint, snapshot(row));
    });
    if (!result.session) return result;
    const row = await this.current(actor, result.session.id);
    if (!row) return { revision: result.revision, session: null };
    try {
      await this.telephony.provision(row.sip_username, decryptSecret(this.config, row.sip_secret_encrypted));
    } catch {
      // Durable identity remains retryable with the same key, but cannot be ready.
      throw new AdmissionError("endpoint_unavailable");
    }
    if (!(await this.current(actor, row.id))) {
      await this.pool.query(
        "update agent_desk_sessions set registration_cleaned_at=null where id=$1 and revoked_at is not null",
        [row.id]
      );
      await this.cleanup();
      throw new AdmissionError("not_controller");
    }
    await this.cleanup();
    return {
      ...result,
      sip: {
        username: row.sip_username,
        password: decryptSecret(this.config, row.sip_secret_encrypted),
        domain: this.config.FREESWITCH_DOMAIN,
        websocketUrl:
          this.config.FREESWITCH_WEBRTC_PUBLIC_WS_URL ??
          `wss://${this.config.FREESWITCH_DOMAIN}/freeswitch-ws`,
        iceServers: buildSoftphoneIceServers(this.config, actor.userId)
      }
    };
  }

  private async current(actor: DeskActor, id: string, resumeOccupied = false): Promise<DeskRow | undefined> {
    return (
      await this.pool.query<DeskRow>(
        `select d.* from agent_desk_sessions d join agents a on a.id=d.agent_id join users u on u.id=a.user_id
      where d.id=$1 and d.agent_id=$2 and u.id=$3 and u.is_active and u.auth_version=$4 and d.actor_auth_version=$4
      and d.revoked_at is null and (d.expires_at>clock_timestamp() or ($5 and exists(select 1 from agent_call_slots where agent_id=d.agent_id and state<>'free')))`,
        [id, actor.agentId, actor.userId, actor.authVersion, resumeOccupied]
      )
    ).rows[0];
  }

  async read(actor: DeskActor, id: string): Promise<DeskSessionResponse | null> {
    const row = await this.current(actor, id, true);
    return row ? snapshot(row) : null;
  }

  async update(actor: DeskActor, input: UpdateDeskSessionRequest): Promise<DeskSessionResponse> {
    // No DB connection/locks are held over the FS round trip. CAS below rejects delayed responses.
    const discovered = await this.current(actor, input.deskSessionId, true);
    let endpoint: string | null = null;
    if (input.ready && discovered) {
      try {
        endpoint = verifiedDeskContact(
          await this.telephony.lookup(discovered.sip_username),
          discovered.sip_username
        );
      } catch {
        /* fail closed */
      }
    }
    return this.mutate(actor, input, "PATCH", endpoint);
  }
  async leave(actor: DeskActor, input: DeskMutationRequest): Promise<DeskSessionResponse> {
    const result = await this.mutate(actor, input, "DELETE", null);
    await this.cleanup();
    return result;
  }
  private async mutate(
    actor: DeskActor,
    input: UpdateDeskSessionRequest | DeskMutationRequest,
    method: "PATCH" | "DELETE",
    endpoint: string | null
  ) {
    const fingerprint = requestFingerprint(
      method,
      "/agent/desk-sessions/:sessionId",
      input.deskSessionId,
      input
    );
    return withEligibilityTransaction(this.pool, async (client) => {
      if ("campaignId" in input) await campaignLock(client, input.campaignId);
      await lockEligibilityAgents(client, [actor.agentId]);
      await authenticate(client, actor);
      const previous = await replay(client, actor, input.idempotencyKey, fingerprint);
      if (previous) return previous;
      const row = (
        await client.query<DeskRow>(
          `select * from agent_desk_sessions where id=$1 and agent_id=$2 and actor_auth_version=$3
        and revoked_at is null and (expires_at>clock_timestamp() or exists(select 1 from agent_call_slots where agent_id=$2 and state<>'free')) for update`,
          [input.deskSessionId, actor.agentId, actor.authVersion]
        )
      ).rows[0];
      if (!row) throw new AdmissionError("not_controller");
      if (row.revision !== input.expectedRevision || row.binding_generation !== input.bindingGeneration)
        throw new AdmissionError("revision_conflict");
      const leaving = method === "DELETE";
      const campaignId = "campaignId" in input ? input.campaignId : row.campaign_id;
      const ready =
        !leaving &&
        "ready" in input &&
        input.ready &&
        endpoint !== null &&
        (!row.endpoint_pin || row.endpoint_pin === endpoint);
      const verified = ready ? endpoint : null;
      const changed =
        leaving ||
        campaignId !== row.campaign_id ||
        row.ready !== ready ||
        row.verified_endpoint !== verified;
      if (changed)
        await cancelPendingAgentWork(
          client,
          [actor.agentId],
          leaving ? "desk_left" : campaignId !== row.campaign_id ? "campaign_changed" : "endpoint_unavailable"
        );
      const updated = (
        await client.query<DeskRow>(
          `update agent_desk_sessions set campaign_id=$2,ready=$3,
        verified_endpoint=$4,verified_generation=case when $3 then binding_generation else null end,
        verified_at=case when $3 then clock_timestamp() else null end, endpoint_pin=coalesce(endpoint_pin,$4),
        expires_at=clock_timestamp()+interval '30 seconds',revoked_at=case when $5 then clock_timestamp() else null end,
        revision=revision+case when $6 then 1 else 0 end where id=$1 returning *`,
          [row.id, campaignId, ready, verified, leaving, changed]
        )
      ).rows[0]!;
      const result = leaving ? { revision: updated.revision, session: null } : snapshot(updated);
      return remember(client, actor, input.idempotencyKey, fingerprint, result);
    });
  }

  /** Bounded per pass; expired sessions lose eligibility but occupied media is never released. */
  async reconcile(limit = 20) {
    const rows = (
      await this.pool.query<DeskRow & { user_id: string; auth_version: number }>(
        `select d.*,a.user_id,u.auth_version from agent_desk_sessions d
      join agents a on a.id=d.agent_id join users u on u.id=a.user_id where d.revoked_at is null order by d.registration_checked_at nulls first,d.id limit $1`,
        [limit]
      )
    ).rows;
    for (const row of rows) {
      let endpoint: string | null = null;
      try {
        endpoint = verifiedDeskContact(await this.telephony.lookup(row.sip_username), row.sip_username);
      } catch {
        /* fail closed */
      }
      await withEligibilityTransaction(this.pool, async (client) => {
        await lockEligibilityAgents(client, [row.agent_id]);
        const current = (
          await client.query(
            `select d.*,d.expires_at<=clock_timestamp() or d.actor_auth_version is distinct from u.auth_version or not u.is_active as invalid,
          s.state='free' and not s.reconciliation_required as idle from agent_desk_sessions d
          join agents a on a.id=d.agent_id join users u on u.id=a.user_id join agent_call_slots s on s.agent_id=a.id
          where d.id=$1 and d.revision=$2 and d.binding_generation=$3 and d.revoked_at is null for update of d`,
            [row.id, row.revision, row.binding_generation]
          )
        ).rows[0];
        if (!current) return;
        const revoke = current.invalid && current.idle;
        const clear = current.invalid || !endpoint || current.verified_endpoint !== endpoint;
        const changed = revoke || (clear && (current.ready || current.verified_endpoint));
        await client.query(
          `update agent_desk_sessions set registration_checked_at=clock_timestamp(),
          ready=case when $2 then false else ready end,
          verified_endpoint=case when $2 then null else verified_endpoint end,
          verified_generation=case when $2 then null else verified_generation end,
          verified_at=case when $2 then null else verified_at end,
          revoked_at=case when $3 then clock_timestamp() else revoked_at end,
          revision=revision+case when $4 then 1 else 0 end where id=$1`,
          [row.id, clear, revoke, Boolean(changed)]
        );
        if (changed) await cancelPendingAgentWork(client, [row.agent_id], "endpoint_unavailable");
      });
    }
    await this.cleanup(limit);
  }
  async cleanup(limit = 20) {
    const obsolete = (
      await this.pool.query<DeskRow>(
        `select d.* from agent_desk_sessions d join agent_call_slots s on s.agent_id=d.agent_id
      where d.revoked_at is not null and d.actor_auth_version is not null
      and d.sip_username ~ '^desk_[a-f0-9]{32}$' and d.registration_cleaned_at is null and s.state='free' and not s.reconciliation_required
      order by d.revoked_at,d.id limit $1`,
        [limit]
      )
    ).rows;
    for (const row of obsolete) {
      try {
        await this.telephony.remove(row.sip_username);
        await this.pool.query(
          "update agent_desk_sessions set registration_cleaned_at=clock_timestamp() where id=$1 and revoked_at is not null",
          [row.id]
        );
      } catch {
        /* retry next bounded pass; never flush the profile/current identity */
      }
    }
  }
}
