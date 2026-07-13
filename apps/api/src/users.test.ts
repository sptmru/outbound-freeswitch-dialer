import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { encryptSecret } from "./auth/crypto.js";
import { buildSoftphoneIceServers, getSoftphoneProvisioningForUser } from "./users.js";

describe("user provisioning helpers", () => {
  it("issues Google STUN plus short-lived Coturn REST credentials", () => {
    const config = {
      ICE_STUN_URLS: "stun:stun.l.google.com:19302, stun:stun1.l.google.com:19302",
      TURN_URLS:
        "turn:dialer.example.com:3478?transport=udp,turn:dialer.example.com:3478?transport=tcp,turns:dialer.example.com:5349?transport=tcp",
      TURN_SHARED_SECRET: "test-turn-secret-that-is-at-least-32-bytes",
      TURN_CREDENTIAL_TTL_SECONDS: 3600
    } as AppConfig;

    const result = buildSoftphoneIceServers(config, "agent-id", 1_700_000_000);

    assert.deepEqual(result[0], {
      urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]
    });
    assert.deepEqual(result[1], {
      urls: [
        "turn:dialer.example.com:3478?transport=udp",
        "turn:dialer.example.com:3478?transport=tcp",
        "turns:dialer.example.com:5349?transport=tcp"
      ],
      username: "1700003600:agent-id",
      credential: "y7AAWSXzEbyMOh7mWjDbzMyj228="
    });
  });

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
        role: "agent",
        isActive: true
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
