import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { __testing } from "./auth/routes.js";
import { provisionAgentDirectory } from "./freeswitch/provisioning.js";

describe("auth route helpers", () => {
  it("removes generated FreeSWITCH agent XML when deleting a user", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbound-dialer-auth-"));
    const config = createConfig(tempDir);
    const userId = "11111111-1111-4111-8111-111111111111";
    const filePath = join(tempDir, "directory", "default", "agent_delete.xml");
    const queries: string[] = [];
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

      const result = await __testing.deleteUser(pool, config, userId);

      assert.equal(result, "deleted");
      assert.match(queries.at(-2) ?? "", /delete from users/);
      assert.equal(queries.at(-1), "commit");
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
