import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import type {
  CreateUserRequest,
  DeleteResponse,
  UpdateUserRequest,
  UpdateUserResponse
} from "@outbound-dialer/shared";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { hashSecret, verifySecret } from "./passwords.js";
import { signAuthToken, verifyAuthToken } from "./tokens.js";
import { SESSION_COOKIE_NAME } from "../security.js";
import {
  createUserWithOptionalAgent,
  ensureAgentForUser,
  findUserByEmail,
  findUserById,
  toPublicUser
} from "../users.js";
import {
  deleteAgentDirectory,
  refreshDeletedAgentRegistrations as refreshFreeSwitchDeletedAgentRegistrations,
  type AgentRegistrationRefreshResult
} from "../freeswitch/provisioning.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["agent", "admin"]),
  password: z.string().min(12)
}) satisfies z.ZodType<CreateUserRequest>;

const userParamsSchema = z.object({
  userId: z.string().uuid()
});

const updateUserSchema = z
  .object({
    email: z.string().email().optional(),
    name: z.string().min(1).max(160).optional(),
    role: z.enum(["agent", "admin"]).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(12).optional()
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one user field is required"
  ) satisfies z.ZodType<UpdateUserRequest>;

export function registerAuthRoutes(app: FastifyInstance, config: AppConfig, pool: pg.Pool): void {
  app.post("/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await findUserByEmail(pool, input.email);

    if (!user || user.is_active === false || !(await verifySecret(input.password, user.password_hash))) {
      return reply.code(401).send({ message: "Invalid email or password" });
    }

    const token = signAuthToken(config, {
      sub: user.id,
      email: user.email,
      role: user.role,
      ver: user.auth_version
    });
    reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(config));
    return { token, user: toPublicUser(user) };
  });

  app.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(config));
    return reply.code(204).send();
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    return { user: toPublicUser(user) };
  });

  app.post("/admin/users", async (request, reply) => {
    const actor = await requireUser(request, config, pool);
    if (!actor) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
    if (actor.role !== "admin") {
      return reply.code(403).send({ message: "Admin role required" });
    }

    const input = createUserSchema.parse(request.body);
    const created = await createUserWithOptionalAgent(pool, config, input, {
      onProvisioningError: (error) =>
        request.log.warn(
          { message: error instanceof Error ? error.message : String(error) },
          "FreeSWITCH agent directory provisioning failed after user creation; reconciliation will retry"
        )
    });
    return reply.code(201).send(created);
  });

  app.patch("/admin/users/:userId", async (request, reply): Promise<UpdateUserResponse | void> => {
    const actor = await requireUser(request, config, pool);
    if (!actor) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
    if (actor.role !== "admin") {
      return reply.code(403).send({ message: "Admin role required" });
    }
    const params = userParamsSchema.parse(request.params);
    const input = updateUserSchema.parse(request.body);
    if (params.userId === actor.id && (input.isActive === false || input.role === "agent")) {
      return reply.code(409).send({ message: "You cannot deactivate or remove your own admin access" });
    }

    const updated = await updateUser(pool, config, params.userId, input, {
      onProvisioningError: (error) =>
        request.log.warn(
          { message: error instanceof Error ? error.message : String(error) },
          "FreeSWITCH agent provisioning failed after user update; reconciliation will retry"
        ),
      onRegistrationRefreshError: (details) =>
        request.log.warn(details, "FreeSWITCH registration refresh failed after user update")
    });
    if (updated === "not_found") {
      return reply.code(404).send({ message: "User not found" });
    }
    if (updated === "active_call") {
      return reply.code(409).send({ message: "User has an active call" });
    }
    return { user: updated };
  });

  app.delete("/admin/users/:userId", async (request, reply): Promise<DeleteResponse | void> => {
    const actor = await requireUser(request, config, pool);
    if (!actor) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
    if (actor.role !== "admin") {
      return reply.code(403).send({ message: "Admin role required" });
    }

    const params = userParamsSchema.parse(request.params);
    if (params.userId === actor.id) {
      return reply.code(409).send({ message: "You cannot deactivate your own user" });
    }

    const deleted = await deleteUser(pool, config, params.userId, {
      onProvisioningError: (error) => {
        request.log.warn(
          { message: error instanceof Error ? error.message : String(error) },
          "FreeSWITCH agent cleanup failed after user deactivation; reconciliation will retry"
        );
      },
      onRegistrationRefreshError: (details) => {
        request.log.warn(details, "FreeSWITCH agent registration refresh failed after user deactivation");
      }
    });
    if (deleted === "not_found") {
      return reply.code(404).send({ message: "User not found" });
    }
    if (deleted === "active_call") {
      return reply.code(409).send({ message: "User has an active call" });
    }
    return { ok: true };
  });
}

async function updateUser(
  pool: pg.Pool,
  config: AppConfig,
  userId: string,
  input: UpdateUserRequest,
  options: DeleteUserOptions = {}
): Promise<ReturnType<typeof toPublicUser> | "not_found" | "active_call"> {
  const passwordHash = input.password ? await hashSecret(input.password) : null;
  const client = await pool.connect();
  let sipUsernames: string[] = [];
  let publicUser: ReturnType<typeof toPublicUser> | null = null;
  let deactivated = false;
  try {
    await client.query("begin");
    const current = await client.query<{
      id: string;
      email: string;
      name: string;
      role: "agent" | "admin";
      password_hash: string;
      auth_version: number;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }>("select * from users where id = $1 for update", [userId]);
    const existing = current.rows[0];
    if (!existing) {
      await client.query("rollback");
      return "not_found";
    }

    deactivated = existing.is_active && input.isActive === false;
    const revokeSessions = Boolean(input.password) || deactivated;
    if (deactivated) {
      const activeCalls = await client.query(
        `
          select 1
          from calls
          join agents on agents.id = calls.agent_id
          where agents.user_id = $1
            and calls.ended_at is null
            and calls.state not in ('completed', 'failed', 'canceled', 'agent_released')
          limit 1
        `,
        [userId]
      );
      if (activeCalls.rowCount) {
        await client.query("rollback");
        return "active_call";
      }
    }

    const updated = await client.query<typeof existing>(
      `
        update users
        set email = $2,
            name = $3,
            role = $4,
            is_active = $5,
            password_hash = $6,
            auth_version = auth_version + $7,
            updated_at = now()
        where id = $1
        returning *
      `,
      [
        userId,
        (input.email ?? existing.email).toLowerCase(),
        input.name ?? existing.name,
        input.role ?? existing.role,
        input.isActive ?? existing.is_active,
        passwordHash ?? existing.password_hash,
        revokeSessions ? 1 : 0
      ]
    );
    await client.query("update agents set display_name = $2, updated_at = now() where user_id = $1", [
      userId,
      input.name ?? existing.name
    ]);
    if (deactivated) {
      await client.query(
        "update agents set status = 'offline', registered = false, updated_at = now() where user_id = $1",
        [userId]
      );
    }
    const agents = await client.query<{ sip_username: string }>(
      "select sip_username from agents where user_id = $1",
      [userId]
    );
    sipUsernames = agents.rows.map((agent) => agent.sip_username);
    publicUser = toPublicUser(updated.rows[0]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  try {
    if (deactivated) {
      await Promise.all(sipUsernames.map((sipUsername) => deleteAgentDirectory(config, sipUsername)));
      const refresh = await (
        options.refreshDeletedAgentRegistrations ?? refreshFreeSwitchDeletedAgentRegistrations
      )(config, sipUsernames);
      if (refresh.errors.length) {
        options.onRegistrationRefreshError?.({ errors: refresh.errors, sipUsernames, userId });
      }
    } else if (publicUser?.isActive) {
      await ensureAgentForUser(pool, config, publicUser);
    }
  } catch (error) {
    if (!options.onProvisioningError) throw error;
    options.onProvisioningError(error);
  }
  return publicUser ?? "not_found";
}

async function deleteUser(
  pool: pg.Pool,
  config: AppConfig,
  userId: string,
  options: DeleteUserOptions = {}
): Promise<"deleted" | "not_found" | "active_call"> {
  const client = await pool.connect();
  let deletedAgentSipUsernames: string[] = [];
  try {
    await client.query("begin");
    const user = await client.query("select id from users where id = $1 for update", [userId]);
    if (!user.rowCount) {
      await client.query("rollback");
      return "not_found";
    }

    const activeCalls = await client.query(
      `
        select 1
        from calls
        join agents on agents.id = calls.agent_id
        where agents.user_id = $1
          and calls.ended_at is null
          and calls.state not in ('completed', 'failed', 'canceled', 'agent_released')
        limit 1
      `,
      [userId]
    );
    if (activeCalls.rowCount) {
      await client.query("rollback");
      return "active_call";
    }

    const agents = await client.query<{ sip_username: string }>(
      "select sip_username from agents where user_id = $1",
      [userId]
    );
    deletedAgentSipUsernames = agents.rows.map((agent) => agent.sip_username);

    await client.query(
      "update users set is_active = false, auth_version = auth_version + 1, updated_at = now() where id = $1",
      [userId]
    );
    await client.query(
      "update agents set status = 'offline', registered = false, updated_at = now() where user_id = $1",
      [userId]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  try {
    await Promise.all(
      deletedAgentSipUsernames.map((sipUsername) => deleteAgentDirectory(config, sipUsername))
    );
    const registrationRefresh = await (
      options.refreshDeletedAgentRegistrations ?? refreshFreeSwitchDeletedAgentRegistrations
    )(config, deletedAgentSipUsernames);
    if (registrationRefresh.errors.length) {
      options.onRegistrationRefreshError?.({
        errors: registrationRefresh.errors,
        sipUsernames: deletedAgentSipUsernames,
        userId
      });
    }
  } catch (error) {
    if (!options.onProvisioningError) throw error;
    options.onProvisioningError(error);
  }
  return "deleted";
}

type DeleteUserOptions = {
  refreshDeletedAgentRegistrations?: typeof refreshFreeSwitchDeletedAgentRegistrations;
  onRegistrationRefreshError?: (details: {
    errors: AgentRegistrationRefreshResult["errors"];
    sipUsernames: string[];
    userId: string;
  }) => void;
  onProvisioningError?: (error: unknown) => void;
};

export async function requireUser(request: FastifyRequest, config: AppConfig, pool: pg.Pool) {
  const authorization = request.headers.authorization;
  const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  const token = bearerToken || request.cookies[SESSION_COOKIE_NAME] || null;
  if (!token) {
    return null;
  }

  const payload = verifyAuthToken(config, token);
  if (!payload) {
    return null;
  }

  const user = await findUserById(pool, payload.sub);
  return !user || user.is_active === false || user.auth_version !== payload.ver ? null : user;
}

function sessionCookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    maxAge: config.JWT_EXPIRES_SECONDS,
    path: "/",
    sameSite: "strict" as const,
    secure: config.NODE_ENV === "production"
  };
}

export const __testing = {
  deleteUser,
  updateUser
};
