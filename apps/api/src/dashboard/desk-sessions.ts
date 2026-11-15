import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { requireUser } from "../auth/routes.js";
import { AdmissionError } from "../call-admission.js";
import {
  createDeskSessionSchema,
  deskMutationSchema,
  updateDeskSessionSchema
} from "../call-coordination-contracts.js";
import { DeskSessions } from "../desk-sessions.js";

export function registerDeskSessionRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pool: pg.Pool,
  service = new DeskSessions(pool, config)
) {
  for (const method of ["POST", "PATCH", "DELETE"] as const) {
    app.route({
      method,
      url: method === "POST" ? "/agent/desk-sessions" : "/agent/desk-sessions/:sessionId",
      handler: async (request, reply) => {
        const user = await requireUser(request, config, pool);
        if (!user) return reply.code(401).send({ message: "Unauthorized" });
        const agent = (await pool.query("select id from agents where user_id=$1", [user.id])).rows[0];
        if (!agent)
          return reply
            .code(409)
            .send({ message: "Agent Desk is unavailable", code: "coordination_unavailable", revision: null });
        const actor = { agentId: agent.id, userId: user.id, authVersion: user.auth_version };
        try {
          reply.header("Cache-Control", "no-store");
          if (method === "POST")
            return await service.create(actor, createDeskSessionSchema.parse(request.body));
          const { sessionId } = z.object({ sessionId: z.guid() }).parse(request.params);
          if (method === "PATCH") {
            const input = updateDeskSessionSchema.parse(request.body);
            if (input.deskSessionId !== sessionId) throw new AdmissionError("not_controller");
            return await service.update(actor, input);
          }
          const input = deskMutationSchema.parse(request.body);
          if (input.deskSessionId !== sessionId) throw new AdmissionError("not_controller");
          return await service.leave(actor, input);
        } catch (error) {
          if (!(error instanceof AdmissionError)) throw error;
          const params = z.object({ sessionId: z.guid() }).safeParse(request.params);
          const fresh =
            error.reason === "revision_conflict" && params.success
              ? await service.read(actor, params.data.sessionId)
              : null;
          return reply.code(409).send({
            message: error.reason,
            code: error.reason,
            revision: fresh?.revision ?? null,
            ...(fresh ? { session: fresh.session } : {})
          });
        }
      }
    });
  }
}
