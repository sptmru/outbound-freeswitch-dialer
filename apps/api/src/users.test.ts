import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { encryptSecret } from "./auth/crypto.js";
import { getSoftphoneProvisioningForUser } from "./users.js";

describe("user provisioning helpers", () => {
  it("recreates missing FreeSWITCH XML before returning existing softphone credentials", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbound-dialer-users-"));
    const config = createConfig(tempDir);
    const encryptedSipPassword = encryptSecret(config, "sip-secret");
    const agentRow = {
      id: "22222222-2222-4222-8222-222222222222",
      sip_username: "agent_existing",
      sip_password_encrypted: encryptedSipPassword,
      display_name: "Existing Agent"
    };
    const pool = createQueryPool((sql) => {
      if (sql.includes("select id, sip_username, sip_password_encrypted, display_name")) {
        return rows([agentRow]);
      }
      if (sql.includes("select sip_username, sip_password_encrypted, display_name")) {
        return rows([agentRow]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    try {
      const provisioning = await getSoftphoneProvisioningForUser(pool, config, {
        id: "11111111-1111-4111-8111-111111111111",
        email: "agent@example.com",
        name: "Fallback Name",
        role: "agent"
      });

      assert.equal(provisioning.sipUsername, "agent_existing");
      assert.equal(provisioning.sipPassword, "sip-secret");
      assert.equal(provisioning.displayName, "Existing Agent");
      assert.match(
        await readFile(join(tempDir, "directory", "default", "agent_existing.xml"), "utf8"),
        /<user id="agent_existing">/
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createConfig(generatedConfigDir: string): AppConfig {
  return {
    FREESWITCH_GENERATED_CONFIG_DIR: generatedConfigDir,
    FREESWITCH_DOMAIN: "dialer.local",
    JWT_SECRET: "test-secret-that-is-at-least-32-bytes"
  } as AppConfig;
}

function createQueryPool(
  handler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number }
): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
