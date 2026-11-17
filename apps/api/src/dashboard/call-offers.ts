import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { coordinationErrorCodes } from "@outbound-dialer/shared";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { requireUser } from "../auth/routes.js";
import { AdmissionError } from "../call-admission.js";
import { deskMutationSchema } from "../call-coordination-contracts.js";
import { ignoreInboundOffer, readInboundOffer } from "../inbound-dispatcher.js";
import { acceptInboundOffer } from "../inbound-acceptance.js";
import { CapacityError } from "../call-capacity.js";
import { ExecutionError } from "../call-executor.js";
import { mutateTransferOffer } from "../transfer-offers.js";

export function registerCallOfferRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pool: pg.Pool,
  connection?: { wakeExecutor(operationId: string): Promise<void> },
  transferConnection?: { wakeExecutor(operationId: string): Promise<void> }
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
          const offer = (
            await pool.query("select kind from call_offers where id=$1 and agent_id=$2", [
              offerId,
              actor.agentId
            ])
          ).rows[0];
          const executor = offer?.kind === "transfer" ? transferConnection : connection;
          if (action === "accept" && !executor) throw new AdmissionError("coordination_unavailable");
          const result =
            offer?.kind === "transfer"
              ? await mutateTransferOffer(
                  pool,
                  actor,
                  offerId,
                  input,
                  action === "accept" ? "accept" : "ignore"
                )
              : action === "accept"
                ? await acceptInboundOffer(pool, actor, offerId, input)
                : await ignoreInboundOffer(pool, actor, offerId, input);
          if ("conflict" in result)
            return reply
              .code(409)
              .send({ message: result.conflict, code: result.conflict, revision: input.expectedRevision });
          if ("operationId" in result && executor) {
            // Response never awaits media/ESL. Durable polling recovers a lost wake.
            void executor
              .wakeExecutor(result.operationId)
              .catch((error) => request.log.error({ err: error }, "Call connection wake failed"));
          }
          return result;
        } catch (error) {
          if (
            !(error instanceof AdmissionError) &&
            !(error instanceof ExecutionError) &&
            !(error instanceof CapacityError)
          )
            throw error;
          const code =
            error instanceof CapacityError
              ? "capacity_exhausted"
              : (coordinationErrorCodes.find((code) => code === error.reason) ?? "coordination_unavailable");
          return reply.code(409).send({ message: error.reason, code, revision: null });
        }
      }
    });
  }
}
