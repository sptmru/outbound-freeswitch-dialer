import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { __testing, registerAuthRoutes } from "./auth/routes.js";
import { hashSecret } from "./auth/passwords.js";
import { provisionAgentDirectory } from "./freeswitch/provisioning.js";

describe("auth route helpers", () => {
  it("sets, accepts and clears the HttpOnly session cookie while preserving bearer auth", async () => {
    const app = Fastify();
    await app.register(cookie);
    const password = "correct-horse-battery-staple";
    const user = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "agent@example.com",
      name: "Agent",
      role: "agent" as const,
      password_hash: await hashSecret(password),
      auth_version: 3,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date()
    };
    let currentAuthVersion = user.auth_version;
    const pool = {
      query: async (sql: string) =>
        rows(sql.includes("from users") ? [{ ...user, auth_version: currentAuthVersion }] : [])
    } as unknown as pg.Pool;
    const config = {
      JWT_EXPIRES_SECONDS: 3600,
      JWT_SECRET: "test-jwt-secret-that-is-long-enough-for-tests",
      NODE_ENV: "production"
    } as AppConfig;
    registerAuthRoutes(app, config, pool);

    try {
      const login = await app.inject({
        method: "POST",
        payload: { email: user.email, password },
        url: "/auth/login"
      });
      assert.equal(login.statusCode, 200);
      const body = login.json<{ token: string }>();
      assert.ok(body.token);
      const setCookie = login.headers["set-cookie"];
      if (typeof setCookie !== "string") {
        assert.fail("login must return one Set-Cookie header");
      }
      assert.match(setCookie, /^outbound_dialer_session=/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /Secure/);
      assert.match(setCookie, /Path=\//);
      const cookieHeader = setCookie.split(";", 1)[0];

      assert.equal(
        (await app.inject({ headers: { cookie: cookieHeader }, method: "GET", url: "/auth/me" })).statusCode,
        200
      );
      assert.equal(
        (
          await app.inject({
            headers: { authorization: `Bearer ${body.token}` },
            method: "GET",
            url: "/auth/me"
          })
        ).statusCode,
        200
      );

      currentAuthVersion += 1;
      assert.equal(
        (await app.inject({ headers: { cookie: cookieHeader }, method: "GET", url: "/auth/me" })).statusCode,
        401
      );

      const logout = await app.inject({
        headers: { cookie: cookieHeader },
        method: "POST",
        url: "/auth/logout"
      });
      assert.equal(logout.statusCode, 204);
      const clearedCookie = logout.headers["set-cookie"];
      if (typeof clearedCookie !== "string") {
        assert.fail("logout must return one Set-Cookie header");
      }
      assert.match(clearedCookie, /^outbound_dialer_session=;/);
      assert.match(clearedCookie, /Expires=Thu, 01 Jan 1970/);
    } finally {
      await app.close();
    }
  });

  it("deactivates a user without deleting history and removes generated FreeSWITCH agent XML", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbound-dialer-auth-"));
    const config = createConfig(tempDir);
    const userId = "11111111-1111-4111-8111-111111111111";
    const filePath = join(tempDir, "directory", "default", "agent_delete.xml");
    const queries: string[] = [];
    let refreshedSipUsernames: string[] = [];
    let refreshedAfterCommit = false;
    const pool = createClientPool((sql) => {
      queries.push(sql);
      if (sql === "begin" || sql === "commit" || sql === "rollback") {
        return rows([]);
      }
      if (sql.includes("select id from users")) {
        return rows([{ id: userId }]);
      }
      if (sql.includes("from calls")) {
        return rows([]);
      }
      if (sql.includes("select sip_username from agents")) {
        return rows([{ sip_username: "agent.delete" }]);
      }
      return rows([]);
    });

    try {
      await provisionAgentDirectory(config, {
        sipUsername: "agent.delete",
        sipPassword: "secret",
        displayName: "Delete Agent"
      });
      await access(filePath);

      const result = await __testing.deleteUser(pool, config, userId, {
        refreshDeletedAgentRegistrations: async (_config, sipUsernames) => {
          refreshedAfterCommit = queries.at(-1) === "commit";
          refreshedSipUsernames = sipUsernames;
          await assertFileMissing(filePath);
          return { commands: ["reloadxml"], errors: [], skipped: false };
        }
      });

      assert.equal(result, "deleted");
      assert.ok(
        queries.some((query) =>
          query.includes("update users set is_active = false, auth_version = auth_version + 1")
        )
      );
      assert.ok(!queries.some((query) => query.includes("delete from users")));
      assert.equal(queries.at(-1), "commit");
      assert.equal(refreshedAfterCommit, true);
      assert.deepEqual(refreshedSipUsernames, ["agent.delete"]);
      await assertFileMissing(filePath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createConfig(generatedConfigDir: string): AppConfig {
  return {
    FREESWITCH_GENERATED_CONFIG_DIR: generatedConfigDir,
    FREESWITCH_DOMAIN: "dialer.local"
  } as AppConfig;
}

async function assertFileMissing(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return;
  }
  assert.fail(`${filePath} should not exist`);
}

function createClientPool(
  handler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number }
): pg.Pool {
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params)),
    release: () => undefined
  };
  return {
    connect: () => Promise.resolve(client)
  } as unknown as pg.Pool;
}

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
