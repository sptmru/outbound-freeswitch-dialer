import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import type { CreateUserRequest, DeleteResponse } from "@outbound-dialer/shared";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { verifySecret } from "./passwords.js";
import { signAuthToken, verifyAuthToken } from "./tokens.js";
import { createUserWithOptionalAgent, findUserByEmail, findUserById, toPublicUser } from "../users.js";
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

export function registerAuthRoutes(app: FastifyInstance, config: AppConfig, pool: pg.Pool): void {
  app.post("/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await findUserByEmail(pool, input.email);

    if (!user || !(await verifySecret(input.password, user.password_hash))) {
      return reply.code(401).send({ message: "Invalid email or password" });
    }

    return {
      token: signAuthToken(config, {
        sub: user.id,
        email: user.email,
        role: user.role
      }),
      user: toPublicUser(user)
    };
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
    const created = await createUserWithOptionalAgent(pool, config, input);
    return reply.code(201).send(created);
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
      return reply.code(409).send({ message: "You cannot delete your own user" });
    }

    const deleted = await deleteUser(pool, config, params.userId, {
      onRegistrationRefreshError: (details) => {
        request.log.warn(details, "FreeSWITCH agent registration refresh failed after user deletion");
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
          and calls.state not in ('completed', 'failed', 'canceled')
        limit 1
      `,
      [userId]
    );
    if (activeCalls.rowCount) {
      await client.query("rollback");
      return "active_call";
    }

    const agents = await client.query<{ sip_username: string }>("select sip_username from agents where user_id = $1", [
      userId
    ]);
    deletedAgentSipUsernames = agents.rows.map((agent) => agent.sip_username);

    await client.query(
      `
        update call_events
        set agent_id = null
        where agent_id in (select id from agents where user_id = $1)
      `,
      [userId]
    );
    await client.query(
      `
        update calls
        set agent_id = null
        where agent_id in (select id from agents where user_id = $1)
      `,
      [userId]
    );
    await client.query("update suppression_entries set created_by_user_id = null where created_by_user_id = $1", [
      userId
    ]);
    await client.query("delete from users where id = $1", [userId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  await Promise.all(deletedAgentSipUsernames.map((sipUsername) => deleteAgentDirectory(config, sipUsername)));
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
  return "deleted";
}

type DeleteUserOptions = {
  refreshDeletedAgentRegistrations?: typeof refreshFreeSwitchDeletedAgentRegistrations;
  onRegistrationRefreshError?: (details: {
    errors: AgentRegistrationRefreshResult["errors"];
    sipUsernames: string[];
    userId: string;
  }) => void;
};

export async function requireUser(request: FastifyRequest, config: AppConfig, pool: pg.Pool) {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  if (!token) {
    return null;
  }

  const payload = verifyAuthToken(config, token);
  if (!payload) {
    return null;
  }

  return findUserById(pool, payload.sub);
}

export const __testing = {
  deleteUser
};
