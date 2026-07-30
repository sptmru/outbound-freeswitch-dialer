import type pg from "pg";
import { createHmac } from "node:crypto";
import type { UserRole } from "@outbound-dialer/shared";
import type { AppConfig } from "./config.js";
import { decryptSecret, encryptSecret, secretNeedsReencryption } from "./auth/crypto.js";
import { generateSecret, hashSecret } from "./auth/passwords.js";
import { provisionAgentDirectory, reloadAgentDirectories } from "./freeswitch/provisioning.js";

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password_hash: string;
  auth_version: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
}

export interface AgentSoftphoneProvisioning {
  sipUri: string;
  sipUsername: string;
  sipPassword: string;
  displayName: string;
  websocketUrl: string;
  domain: string;
  iceServers: Array<{
    urls: string[];
    username?: string;
    credential?: string;
  }>;
}

function commaSeparatedUrls(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

export function buildSoftphoneIceServers(
  config: AppConfig,
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): AgentSoftphoneProvisioning["iceServers"] {
  const iceServers: AgentSoftphoneProvisioning["iceServers"] = [];
  const stunUrls = commaSeparatedUrls(config.ICE_STUN_URLS);
  if (stunUrls.length) {
    iceServers.push({ urls: stunUrls });
  }

  const turnUrls = commaSeparatedUrls(config.TURN_URLS);
  if (turnUrls.length && config.TURN_SHARED_SECRET) {
    const username = `${nowSeconds + config.TURN_CREDENTIAL_TTL_SECONDS}:${userId}`;
    const credential = createHmac("sha1", config.TURN_SHARED_SECRET).update(username).digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  }

  return iceServers;
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: UserRole;
  password: string;
  callerId?: string | null;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.is_active !== false
  };
}

export async function findUserByEmail(pool: pg.Pool, email: string): Promise<UserRecord | null> {
  const result = await pool.query<UserRecord>("select * from users where lower(email) = lower($1)", [email]);
  return result.rows[0] ?? null;
}

export async function findUserById(pool: pg.Pool, id: string): Promise<UserRecord | null> {
  const result = await pool.query<UserRecord>("select * from users where id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function createUserWithOptionalAgent(
  pool: pg.Pool,
  config: AppConfig,
  input: CreateUserInput,
  options: { onProvisioningError?: (error: unknown) => void } = {}
): Promise<{ user: PublicUser }> {
  const passwordHash = await hashSecret(input.password);
  const client = await pool.connect();

  let directoryAgent: { sipUsername: string; sipPassword: string; displayName: string } | null = null;
  let result: { user: PublicUser } | null = null;
  try {
    await client.query("begin");
    const userResult = await client.query<UserRecord>(
      `
        insert into users (email, name, role, password_hash)
        values ($1, $2, $3, $4)
        returning *
      `,
      [input.email.toLowerCase(), input.name, input.role, passwordHash]
    );

    const user = userResult.rows[0];
    if (input.role === "agent") {
      const sipPassword = generateSecret(18);
      const sipUsername = await nextSipUsername(client, config.SIP_USERNAME_PREFIX);
      await client.query(
        `
          insert into agents (
            user_id,
            sip_username,
            sip_password_hash,
            sip_password_encrypted,
            display_name,
            caller_id
          )
          values ($1, $2, $3, $4, $5, $6)
        `,
        [
          user.id,
          sipUsername,
          await hashSecret(sipPassword),
          encryptSecret(config, sipPassword),
          input.name,
          input.callerId ?? null
        ]
      );
      directoryAgent = { sipUsername, sipPassword, displayName: input.name };
    }

    await client.query("commit");
    result = { user: toPublicUser(user) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  if (directoryAgent) {
    try {
      await provisionAgentDirectory(config, directoryAgent);
    } catch (error) {
      if (!options.onProvisioningError) throw error;
      options.onProvisioningError(error);
    }
  }
  if (!result) throw new Error("User creation committed without a result");
  return result;
}

export async function ensureAgentForUser(
  pool: pg.Pool,
  config: AppConfig,
  user: PublicUser
): Promise<{ id: string; sipUsername: string }> {
  const existing = await pool.query<{
    id: string;
    sip_username: string;
    sip_password_encrypted: string;
    display_name: string;
  }>(
    `
      select id, sip_username, sip_password_encrypted, display_name
      from agents
      where user_id = $1
      order by created_at asc
      limit 1
    `,
    [user.id]
  );
  const existingAgent = existing.rows[0];
  if (existingAgent) {
    await provisionAgentDirectory(config, {
      sipUsername: existingAgent.sip_username,
      sipPassword: decryptSecret(config, existingAgent.sip_password_encrypted),
      displayName: existingAgent.display_name || user.name
    });
    return {
      id: existingAgent.id,
      sipUsername: existingAgent.sip_username
    };
  }

  const sipPassword = generateSecret(18);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sipUsername = await nextSipUsername(client, config.SIP_USERNAME_PREFIX);
    const created = await client.query<{
      id: string;
      sip_username: string;
    }>(
      `
        insert into agents (user_id, sip_username, sip_password_hash, sip_password_encrypted, display_name, status)
        values ($1, $2, $3, $4, $5, 'offline')
        returning id, sip_username
      `,
      [user.id, sipUsername, await hashSecret(sipPassword), encryptSecret(config, sipPassword), user.name]
    );
    await client.query("commit");
    await provisionAgentDirectory(config, { sipUsername, sipPassword, displayName: user.name });
    const row = created.rows[0];
    return {
      id: row.id,
      sipUsername: row.sip_username
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getSoftphoneProvisioningForUser(
  pool: pg.Pool,
  config: AppConfig,
  user: PublicUser
): Promise<AgentSoftphoneProvisioning> {
  await ensureAgentForUser(pool, config, user);
  const result = await pool.query<{
    sip_username: string;
    sip_password_encrypted: string;
    display_name: string;
  }>(
    `
      select sip_username, sip_password_encrypted, display_name
      from agents
      where user_id = $1
      order by created_at asc
      limit 1
    `,
    [user.id]
  );
  const agent = result.rows[0];
  if (!agent) {
    throw new Error("Agent credentials are unavailable");
  }
  const sipPassword = decryptSecret(config, agent.sip_password_encrypted);
  const displayName = agent.display_name || user.name;
  await provisionAgentDirectory(config, {
    sipUsername: agent.sip_username,
    sipPassword,
    displayName
  });
  await reloadAgentDirectories(config);

  return {
    sipUri: `sip:${agent.sip_username}@${config.FREESWITCH_DOMAIN}`,
    sipUsername: agent.sip_username,
    sipPassword,
    displayName,
    websocketUrl: config.FREESWITCH_WEBRTC_PUBLIC_WS_URL ?? `wss://${config.FREESWITCH_DOMAIN}/freeswitch-ws`,
    domain: config.FREESWITCH_DOMAIN,
    iceServers: buildSoftphoneIceServers(config, user.id)
  };
}

export async function bootstrapAdmin(pool: pg.Pool, config: AppConfig): Promise<PublicUser | null> {
  if (!config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) {
    return null;
  }

  const existing = await findUserByEmail(pool, config.BOOTSTRAP_ADMIN_EMAIL);
  if (existing) {
    return toPublicUser(existing);
  }

  const created = await createUserWithOptionalAgent(pool, config, {
    email: config.BOOTSTRAP_ADMIN_EMAIL,
    name: config.BOOTSTRAP_ADMIN_NAME,
    role: "admin",
    password: config.BOOTSTRAP_ADMIN_PASSWORD
  });

  return created.user;
}

export async function migrateAgentSipSecretEncryption(pool: pg.Pool, config: AppConfig): Promise<number> {
  // Keep v2 writes opt-in so the first dual-read release can still roll back to
  // the previous v1-only image. Enable v2 only on a later deployment.
  if (!config.SIP_SECRET_ENCRYPTION_KEY || config.SIP_SECRET_WRITE_VERSION !== "v2") {
    return 0;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const agents = await client.query<{ id: string; sip_password_encrypted: string }>(
      "select id, sip_password_encrypted from agents where sip_password_encrypted like 'v1.%' for update"
    );
    let migrated = 0;
    for (const agent of agents.rows) {
      if (!secretNeedsReencryption(config, agent.sip_password_encrypted)) {
        continue;
      }
      const plaintext = decryptSecret(config, agent.sip_password_encrypted);
      await client.query("update agents set sip_password_encrypted = $2, updated_at = now() where id = $1", [
        agent.id,
        encryptSecret(config, plaintext)
      ]);
      migrated += 1;
    }
    const supervisorEndpoints = await client.query<{
      user_id: string;
      sip_password_encrypted: string;
    }>(
      "select user_id, sip_password_encrypted from admin_supervisor_endpoints where sip_password_encrypted like 'v1.%' for update"
    );
    for (const endpoint of supervisorEndpoints.rows) {
      if (!secretNeedsReencryption(config, endpoint.sip_password_encrypted)) continue;
      const plaintext = decryptSecret(config, endpoint.sip_password_encrypted);
      await client.query(
        "update admin_supervisor_endpoints set sip_password_encrypted = $2, updated_at = now() where user_id = $1",
        [endpoint.user_id, encryptSecret(config, plaintext)]
      );
      migrated += 1;
    }
    await client.query("commit");
    return migrated;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function nextSipUsername(client: pg.PoolClient, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = generateSecret(5)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 8);
    const username = `${prefix}_${suffix}`;
    const existing = await client.query(
      `select 1 from agents where sip_username = $1
       union all
       select 1 from admin_supervisor_endpoints where sip_username = $1
       limit 1`,
      [username]
    );
    if (!existing.rowCount) {
      return username;
    }
  }

  throw new Error("failed to generate unique SIP username");
}
