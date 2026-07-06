import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { verifySecret } from "./passwords.js";
import { signAuthToken, verifyAuthToken } from "./tokens.js";
import { createUserWithOptionalAgent, findUserByEmail, findUserById, toPublicUser } from "../users.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["agent", "admin"]),
  password: z.string().min(12)
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
}

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
