import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { coordinationErrorCodes } from "@outbound-dialer/shared";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { requireUser } from "../auth/routes.js";
import { AdmissionError } from "../call-admission.js";
import { createTransferSchema, deskMutationSchema } from "../call-coordination-contracts.js";
import { createTransferOffer, mutateTransferOffer, readTransferTargets } from "../transfer-offers.js";
import { CapacityError } from "../call-capacity.js";
import { ExecutionError } from "../call-executor.js";

export function registerTransferRoutes(app: FastifyInstance, config: AppConfig, pool: pg.Pool) {
  for (const action of ["targets", "create", "cancel"] as const) {
    app.route({
      method: action === "targets" ? "GET" : action === "create" ? "POST" : "DELETE",
      url: `/agent/calls/:callId/${action === "targets" ? "transfer-targets" : action === "create" ? "transfers" : "transfers/:transferId"}`,
      handler: async (request, reply) => {
        const user = await requireUser(request, config, pool);
        if (!user) return reply.code(401).send({ message: "Unauthorized" });
        const agent = (await pool.query("select id from agents where user_id=$1", [user.id])).rows[0];
        if (!agent)
          return reply
            .code(409)
            .send({ message: "Agent Desk is unavailable", code: "coordination_unavailable", revision: null });
        const actor = { userId: user.id, agentId: agent.id, authVersion: user.auth_version };
        const params = z.object({ callId: z.guid(), transferId: z.guid().optional() }).parse(request.params);
        reply.header("Cache-Control", "no-store");
        try {
          const result =
            action === "targets"
              ? await readTransferTargets(
                  pool,
                  actor,
                  params.callId,
                  z.object({ deskSessionId: z.guid() }).strict().parse(request.query).deskSessionId
                )
              : action === "create"
                ? await createTransferOffer(
                    pool,
                    actor,
                    params.callId,
                    createTransferSchema.parse(request.body)
                  )
                : await mutateTransferOffer(
                    pool,
                    actor,
                    params.transferId!,
                    deskMutationSchema.parse(request.body),
                    "cancel",
                    params.callId
                  );
          if ("conflict" in result)
            return reply.code(409).send({ message: result.conflict, code: result.conflict, revision: null });
          return result;
        } catch (error) {
          if (
            !(error instanceof AdmissionError) &&
            !(error instanceof CapacityError) &&
            !(error instanceof ExecutionError)
          )
            throw error;
          return reply.code(409).send({
            message: error.reason,
            code:
              error instanceof CapacityError
                ? "capacity_exhausted"
                : (coordinationErrorCodes.find((code) => code === error.reason) ??
                  "coordination_unavailable"),
            revision: null
          });
        }
      }
    });
  }
}
