import type pg from "pg";
import type { UserRole } from "@outbound-dialer/shared";
import type { AppConfig } from "./config.js";
import { encryptSecret } from "./auth/crypto.js";
import { generateSecret, hashSecret } from "./auth/passwords.js";
import { provisionAgentDirectory } from "./freeswitch/provisioning.js";

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface AgentCredentials {
  sipUsername: string;
  sipPassword: string;
}

export interface CreateUserInput {
  email: string;
  name: string;
  role: UserRole;
  password: string;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role
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
  input: CreateUserInput
): Promise<{ user: PublicUser; agentCredentials?: AgentCredentials }> {
  const passwordHash = await hashSecret(input.password);
  const client = await pool.connect();

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
    let agentCredentials: AgentCredentials | undefined;

    if (input.role === "agent") {
      const sipPassword = generateSecret(18);
      const sipUsername = await nextSipUsername(client, config.SIP_USERNAME_PREFIX);
      await client.query(
        `
          insert into agents (user_id, sip_username, sip_password_hash, sip_password_encrypted, display_name)
          values ($1, $2, $3, $4, $5)
        `,
        [user.id, sipUsername, await hashSecret(sipPassword), encryptSecret(config, sipPassword), input.name]
      );
      await provisionAgentDirectory(config, { sipUsername, sipPassword, displayName: input.name });
      agentCredentials = { sipUsername, sipPassword };
    }

    await client.query("commit");
    return { user: toPublicUser(user), agentCredentials };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureAgentForUser(
  pool: pg.Pool,
  config: AppConfig,
  user: PublicUser
): Promise<{ id: string; sipUsername: string }> {
  const existing = await pool.query<{
    id: string;
    sip_username: string;
  }>("select id, sip_username from agents where user_id = $1 order by created_at asc limit 1", [user.id]);
  if (existing.rows[0]) {
    return {
      id: existing.rows[0].id,
      sipUsername: existing.rows[0].sip_username
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
        values ($1, $2, $3, $4, $5, 'ready')
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

async function nextSipUsername(client: pg.PoolClient, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = generateSecret(5).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
    const username = `${prefix}_${suffix}`;
    const existing = await client.query("select 1 from agents where sip_username = $1", [username]);
    if (!existing.rowCount) {
      return username;
    }
  }

  throw new Error("failed to generate unique SIP username");
}
