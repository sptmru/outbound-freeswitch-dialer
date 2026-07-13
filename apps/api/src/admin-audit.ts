import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { requireUser } from "./auth/routes.js";

const MUTATING_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export function registerAdminAudit(app: FastifyInstance, config: AppConfig, pool: pg.Pool): void {
  const auditEvents = new WeakMap<object, string>();

  app.addHook("preHandler", async (request) => {
    const route = request.routeOptions.url;
    if (!route?.startsWith("/admin/") || !MUTATING_METHODS.has(request.method)) {
      return;
    }
    const actor = await requireUser(request, config, pool);
    if (actor?.role === "admin") {
      const inserted = await pool.query<{ id: string }>(
        `
          insert into admin_audit_events (
            actor_user_id,
            request_id,
            method,
            route,
            status_code,
            source_ip,
            user_agent,
            metadata_json
          )
          values ($1, $2, $3, $4, 102, $5, $6, $7::jsonb)
          returning id
        `,
        [
          actor.id,
          request.id,
          request.method,
          route,
          request.ip,
          request.headers["user-agent"] ?? null,
          JSON.stringify({ params: redactRouteParams(request.params) })
        ]
      );
      const auditEventId = inserted.rows[0]?.id;
      if (!auditEventId) {
        throw new Error("Admin audit event was not persisted");
      }
      auditEvents.set(request, auditEventId);
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const route = request.routeOptions.url;
    if (!route?.startsWith("/admin/") || !MUTATING_METHODS.has(request.method)) {
      return payload;
    }

    const auditEventId = auditEvents.get(request);
    if (!auditEventId) {
      return payload;
    }
    auditEvents.delete(request);

    await pool.query(
      `
        update admin_audit_events
        set status_code = $2
        where id = $1
      `,
      [auditEventId, reply.statusCode]
    );
    return payload;
  });
}

function redactRouteParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item === "string")
      .map(([key, item]) => [key, String(item).slice(0, 160)])
  );
}
