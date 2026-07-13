import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { registerAdminAudit } from "./admin-audit.js";
import { signAuthToken } from "./auth/tokens.js";

describe("admin audit", () => {
  it("registers an onSend hook so audit persistence precedes a successful response", () => {
    const hookNames: string[] = [];
    const app = {
      addHook: (name: string) => {
        hookNames.push(name);
      }
    } as unknown as FastifyInstance;

    registerAdminAudit(app, {} as AppConfig, {} as pg.Pool);

    assert.deepEqual(hookNames, ["preHandler", "onSend"]);
  });

  it("persists the actor and route after a successful admin mutation", async () => {
    const app = (await import("fastify")).default();
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const user = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      password_hash: "unused",
      auth_version: 2,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date()
    };
    const pool = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("insert into admin_audit_events")) {
          return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 };
        }
        return sql.includes("from users") ? { rows: [user], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
    } as unknown as pg.Pool;
    const config = {
      JWT_EXPIRES_SECONDS: 3600,
      JWT_SECRET: "test-jwt-secret-that-is-long-enough-for-tests"
    } as AppConfig;
    const token = signAuthToken(config, {
      sub: user.id,
      email: user.email,
      role: "admin",
      ver: user.auth_version
    });
    registerAdminAudit(app, config, pool);
    app.patch("/admin/widgets/:widgetId", async () => ({ ok: true }));

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: "PATCH",
        url: "/admin/widgets/22222222-2222-4222-8222-222222222222"
      });
      assert.equal(response.statusCode, 200);
      const insert = queries.find((query) => query.sql.includes("insert into admin_audit_events"));
      const update = queries.find((query) => query.sql.includes("update admin_audit_events"));
      assert.equal(insert?.params[0], user.id);
      assert.equal(insert?.params[2], "PATCH");
      assert.equal(insert?.params[3], "/admin/widgets/:widgetId");
      assert.match(String(insert?.params[6]), /widgetId/);
      assert.deepEqual(update?.params, ["33333333-3333-4333-8333-333333333333", 200]);
    } finally {
      await app.close();
    }
  });

  it("does not execute an admin mutation when the durable audit write fails", async () => {
    const app = (await import("fastify")).default();
    let mutationExecuted = false;
    const user = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      password_hash: "unused",
      auth_version: 2,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date()
    };
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("from users")) return { rows: [user], rowCount: 1 };
        throw new Error("audit storage unavailable");
      }
    } as unknown as pg.Pool;
    const config = {
      JWT_EXPIRES_SECONDS: 3600,
      JWT_SECRET: "test-jwt-secret-that-is-long-enough-for-tests"
    } as AppConfig;
    const token = signAuthToken(config, {
      sub: user.id,
      email: user.email,
      role: "admin",
      ver: user.auth_version
    });
    registerAdminAudit(app, config, pool);
    app.post("/admin/widgets", async () => {
      mutationExecuted = true;
      return { ok: true };
    });

    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: "POST",
        url: "/admin/widgets"
      });
      assert.equal(response.statusCode, 500);
      assert.equal(mutationExecuted, false);
    } finally {
      await app.close();
    }
  });
});
