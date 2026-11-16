import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { requireUser } from "../auth/routes.js";
import {
  inboundAdminMutationSchema,
  saveInboundNumberSchema,
  saveInboundQueueSchema,
  saveInboundFlowSchema
} from "../call-coordination-contracts.js";
import { InboundAdminError, listInboundConfiguration, mutateInboundConfiguration } from "../inbound-admin.js";

export function registerInboundAdminRoutes(app: FastifyInstance, config: AppConfig, pool: pg.Pool) {
  for (const resource of ["numbers", "queues", "flows"] as const) {
    for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
      app.route({
        method,
        url: `/admin/inbound-${resource}${method === "PATCH" || method === "DELETE" ? "/:id" : ""}`,
        handler: async (request, reply) => {
          const user = await requireUser(request, config, pool);
          if (!user) return reply.code(401).send({ message: "Unauthorized" });
          if (user.role !== "admin")
            return reply.code(403).send({ message: "Administrator access required" });
          reply.header("Cache-Control", "no-store");
          if (method === "GET") return listInboundConfiguration(pool, resource);
          const id = method === "POST" ? null : z.object({ id: z.guid() }).parse(request.params).id;
          const schema =
            method === "DELETE"
              ? inboundAdminMutationSchema
              : resource === "numbers"
                ? saveInboundNumberSchema
                : resource === "queues"
                  ? saveInboundQueueSchema
                  : saveInboundFlowSchema;
          const input = schema.parse(request.body);
          try {
            return await mutateInboundConfiguration(
              pool,
              { id: user.id, authVersion: user.auth_version, requestId: String(request.id).slice(0, 128) },
              resource,
              method,
              id,
              input
            );
          } catch (error) {
            if (!(error instanceof InboundAdminError)) throw error;
            return reply.code(error.status).send({ message: error.code, code: error.code });
          }
        }
      });
    }
  }
}
