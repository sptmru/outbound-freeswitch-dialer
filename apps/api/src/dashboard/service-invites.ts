import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { requireUser } from "../auth/routes.js";
import { AdmissionError } from "../call-admission.js";
import { authorizeServiceInvite, serviceInviteSchema } from "../service-invites.js";

export function registerServiceInviteRoutes(app: FastifyInstance, config: AppConfig, pool: pg.Pool) {
  app.post("/agent/service-invites/authorize", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const user = await requireUser(request, config, pool);
    if (!user) return reply.code(401).send({ message: "Unauthorized" });
    const input = serviceInviteSchema.parse(request.body);
    const agent = (await pool.query("select id from agents where user_id=$1", [user.id])).rows[0];
    let authorized = false;
    try {
      if (agent)
        authorized = await authorizeServiceInvite(
          pool,
          { agentId: agent.id, userId: user.id, authVersion: user.auth_version },
          input
        );
    } catch (error) {
      if (!(error instanceof AdmissionError)) throw error;
    }
    if (!authorized)
      return reply
        .code(409)
        .send({ message: "Service invitation is unavailable", code: "service_invite_unavailable" });
    return { authorized: true, ...input };
  });
}
