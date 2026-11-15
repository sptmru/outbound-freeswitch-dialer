import assert from "node:assert/strict";
import { test } from "node:test";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import type pg from "pg";
import { ZodError } from "zod";
import { signAuthToken } from "./auth/tokens.js";
import type { AppConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { createDialerCall } from "./dashboard/calls.js";
import { SESSION_COOKIE_NAME, registerCookieCsrfProtection } from "./security.js";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const intent = {
  deskSessionId: id,
  expectedRevision: "1",
  bindingGeneration: "1",
  idempotencyKey: id,
  startReason: "manual"
};
const routeConfig = {
  JWT_SECRET: "b05-isolated-contract-test-secret",
  JWT_EXPIRES_SECONDS: 3600,
  PUBLIC_APP_URL: "https://desk.example.test",
  corsOrigins: [],
  FREESWITCH_ESL_ENABLED: true
} as unknown as AppConfig;
const user = {
  id,
  email: "fixture@example.test",
  name: "B05",
  role: "agent",
  is_active: true,
  auth_version: 1
};
const token = signAuthToken(routeConfig, { sub: id, email: user.email, role: "agent", ver: 1 });
function rows(items: unknown[]) {
  return { rows: items, rowCount: items.length };
}
const starts = [
  { url: "/agent/call-next", payload: {} },
  { url: "/agent/manual-dial/start", payload: { phoneNumber: "+14155550100" } },
  { url: `/agent/leads/${id}/call`, payload: {} }
];

test("B05.3 API rejects unsupported intents, wrong actors and CSRF before mutations or ESL", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      queries.push(sql);
      assert.match(sql, /^select \* from users/);
      assert.deepEqual(params, [id]);
      return rows([user]);
    },
    async connect() {
      throw new Error("Rejected request attempted a mutation/ESL workflow");
    }
  } as unknown as pg.Pool;
  const app = Fastify();
  await app.register(cookie);
  registerCookieCsrfProtection(app, routeConfig);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: "Validation failed" });
    return reply.send(error);
  });
  registerDashboardRoutes(app, routeConfig, pool);
  try {
    for (const start of starts) {
      const auth = { authorization: `Bearer ${token}` };
      const valid = { ...start.payload, intent };
      const denied = await app.inject({ method: "POST", url: start.url, payload: valid });
      assert.equal(denied.statusCode, 401);
      const unsupported = await app.inject({ method: "POST", url: start.url, headers: auth, payload: valid });
      assert.equal(unsupported.statusCode, 409, unsupported.body);
      assert.equal(unsupported.json().code, "coordination_unavailable");
      // Untrusted root actor/agent and nested agent fields must not be stripped into legacy starts.
      for (const payload of [
        { ...start.payload, agentId: other },
        { ...start.payload, actorUserId: other },
        { ...valid, intent: { ...intent, agentId: other } },
        { ...valid, intent: { ...intent, expectedRevision: 1 } }
      ]) {
        const invalid = await app.inject({ method: "POST", url: start.url, headers: auth, payload });
        assert.equal(invalid.statusCode, 400, invalid.body);
      }
      for (const origin of [undefined, "https://untrusted.example.test"]) {
        const csrf = await app.inject({
          method: "POST",
          url: start.url,
          headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, ...(origin ? { origin } : {}) },
          payload: valid
        });
        assert.equal(csrf.statusCode, 403, csrf.body);
      }
      const cookieRequest = await app.inject({
        method: "POST",
        url: start.url,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: routeConfig.PUBLIC_APP_URL },
        payload: valid
      });
      assert.equal(cookieRequest.statusCode, 409, cookieRequest.body);
    }
    const wrongRole = await app.inject({
      method: "POST",
      url: "/admin/campaigns",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Unauthorized" }
    });
    assert.equal(wrongRole.statusCode, 403, wrongRole.body);
    assert.ok(queries.length > 0);
    assert.ok(queries.every((sql) => sql.startsWith("select * from users")));
  } finally {
    await app.close();
  }
});

test("B05.3 legacy metadata stays absent and cannot dismiss coordinated work", async () => {
  // Query ledger oracle, not database/concurrency proof. Rollback precedes every
  // contact/call/offer/operation write and every UUID/originate request.
  for (const contactId of ["next", id, null]) {
    const queries: string[] = [];
    const pool = {
      async connect() {
        return {
          async query(sql: string) {
            queries.push(sql);
            if (sql.includes("select registered,"))
              return rows([{ registered: true, availability_status: "available", caller_id: null }]);
            if (sql.includes("exists(select 1 from agent_desk_sessions")) return rows([{}]);
            return rows([]);
          },
          release() {}
        };
      }
    } as unknown as pg.Pool;
    const result = await createDialerCall(pool, routeConfig, {
      agentId: id,
      campaignId: id,
      contactId,
      sipUsername: "fixture",
      manualDial: contactId === null,
      destinationNumber: "+14155550100",
      normalizedDestinationNumber: "+14155550100",
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      eventType: "fixture"
    });
    assert.deepEqual(result, { ok: false, reason: "legacy_initiator_required" });
    assert.equal(queries.at(-1), "rollback");
    assert.equal(queries.includes("commit"), false);
    assert.equal(
      queries.some((sql) =>
        /(?:insert into|update) (?:calls|contacts|call_offers|call_transfers|call_operations|agent_auto_next_intents)\b/.test(
          sql
        )
      ),
      false
    );
  }
});
