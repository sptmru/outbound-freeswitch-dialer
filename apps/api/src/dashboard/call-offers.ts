import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { requireUser } from "../auth/routes.js";
import { AdmissionError } from "../call-admission.js";
import { deskMutationSchema } from "../call-coordination-contracts.js";
import { ignoreInboundOffer, readInboundOffer } from "../inbound-dispatcher.js";
import { acceptInboundOffer } from "../inbound-acceptance.js";
import { CapacityError } from "../call-capacity.js";
import { ExecutionError } from "../call-executor.js";

export function registerCallOfferRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pool: pg.Pool,
  connection?: { wakeExecutor(operationId: string): Promise<void> }
) {
  for (const action of ["snapshot", "ignore", "accept"] as const) {
    const method = action === "snapshot" ? "GET" : "POST";
    app.route({
      method,
      url: method === "GET" ? "/agent/call-offers" : `/agent/call-offers/:offerId/${action}`,
      handler: async (request, reply) => {
        const user = await requireUser(request, config, pool);
        if (!user) return reply.code(401).send({ message: "Unauthorized" });
        const agent = (await pool.query("select id from agents where user_id=$1", [user.id])).rows[0];
        if (!agent)
          return reply
            .code(409)
            .send({ message: "Agent Desk is unavailable", code: "coordination_unavailable", revision: null });
        const actor = { userId: user.id, agentId: agent.id, authVersion: user.auth_version };
        reply.header("Cache-Control", "no-store");
        try {
          if (method === "GET") {
            const query = z.object({ deskSessionId: z.guid() }).strict().parse(request.query);
            return await readInboundOffer(pool, actor, query.deskSessionId);
          }
          const { offerId } = z.object({ offerId: z.guid() }).parse(request.params);
          const input = deskMutationSchema.parse(request.body);
          if (action === "accept" && !connection) throw new AdmissionError("coordination_unavailable");
          const result =
            action === "accept"
              ? await acceptInboundOffer(pool, actor, offerId, input)
              : await ignoreInboundOffer(pool, actor, offerId, input);
          if ("conflict" in result)
            return reply
              .code(409)
              .send({ message: result.conflict, code: result.conflict, revision: input.expectedRevision });
          if ("operationId" in result && connection) {
            // Response never awaits media/ESL. Durable polling recovers a lost wake.
            void connection
              .wakeExecutor(result.operationId)
              .catch((error) => request.log.error({ err: error }, "Inbound connection wake failed"));
          }
          return result;
        } catch (error) {
          if (
            !(error instanceof AdmissionError) &&
            !(error instanceof ExecutionError) &&
            !(error instanceof CapacityError)
          )
            throw error;
          const code = ["session_revoked", "maintenance", "discovery_changed"].includes(error.reason)
            ? "coordination_unavailable"
            : error.reason;
          return reply.code(409).send({ message: error.reason, code, revision: null });
        }
      }
    });
  }
}
