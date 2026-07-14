import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { encryptSecret } from "./auth/crypto.js";
import {
  deleteAgentDirectory,
  ensureAgentDirectory,
  provisionAgentDirectory,
  reconcileAgentDirectories,
  reloadAgentDirectories,
  refreshDeletedAgentRegistrations
} from "./freeswitch/provisioning.js";

describe("FreeSWITCH provisioning helpers", () => {
  it("recreates a missing generated agent directory XML", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbound-dialer-fs-"));
    const config = createConfig(tempDir);
    const filePath = join(tempDir, "directory", "default", "agent_1001.xml");

    try {
      await ensureAgentDirectory(config, {
        sipUsername: "agent_1001",
        sipPassword: "secret<&>",
        displayName: "Agent <One>"
      });

      const xml = await readFile(filePath, "utf8");
      assert.match(xml, /<user id="agent_1001">/);
      assert.match(xml, /value="secret&lt;&amp;&gt;"/);
      assert.match(xml, /value="Agent &lt;One&gt;"/);

      await rm(filePath);
      await ensureAgentDirectory(config, {
        sipUsername: "agent_1001",
        sipPassword: "secret<&>",
        displayName: "Agent <One>"
      });

      assert.match(await readFile(filePath, "utf8"), /<user id="agent_1001">/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes generated agent directory XML and tolerates missing files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbound-dialer-fs-"));
    const config = createConfig(tempDir);
    const filePath = join(tempDir, "directory", "default", "agent_remove.xml");

    try {
      await provisionAgentDirectory(config, {
        sipUsername: "agent.remove",
        sipPassword: "secret",
        displayName: "Removed Agent"
      });
      await access(filePath);

      await deleteAgentDirectory(config, "agent.remove");
      await assertFileMissing(filePath);

      await deleteAgentDirectory(config, "agent.remove");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reloads XML and flushes deleted registrations through ESL", async () => {
    const commands: string[] = [];
    const config = createConfig("/tmp/outbound-dialer-test", { FREESWITCH_ESL_ENABLED: true });

    const result = await refreshDeletedAgentRegistrations(
      config,
      ["agent.remove", "agent.remove"],
      async (_config, command) => {
        commands.push(command);
      }
    );

    assert.deepEqual(commands, [
      "reloadxml",
      "sofia profile internal-webrtc flush_inbound_reg agent.remove@dialer.local"
    ]);
    assert.deepEqual(result, { commands, errors: [], skipped: false });
  });

  it("reloads provisioned agent directory XML through ESL", async () => {
    const commands: string[] = [];
    const config = createConfig("/tmp/outbound-dialer-test", { FREESWITCH_ESL_ENABLED: true });

    const reloaded = await reloadAgentDirectories(config, async (_config, command) => {
      commands.push(command);
    });

    assert.equal(reloaded, true);
    assert.deepEqual(commands, ["reloadxml"]);
  });

  it("skips agent directory XML reload when ESL is disabled", async () => {
    const reloaded = await reloadAgentDirectories(createConfig("/tmp/outbound-dialer-test"), async () => {
      throw new Error("ESL should not be called");
    });

    assert.equal(reloaded, false);
  });

  it("skips deleted registration refresh when ESL is disabled", async () => {
    const result = await refreshDeletedAgentRegistrations(
      createConfig("/tmp/outbound-dialer-test"),
      ["agent.remove"],
      async () => {
        throw new Error("ESL should not be called");
      }
    );

    assert.deepEqual(result, { commands: [], errors: [], skipped: true });
  });

  it("records ESL refresh errors without throwing", async () => {
    const config = createConfig("/tmp/outbound-dialer-test", { FREESWITCH_ESL_ENABLED: true });

    const result = await refreshDeletedAgentRegistrations(config, ["agent.remove"], async () => {
      throw new Error("ESL unavailable");
    });

    assert.deepEqual(result, {
      commands: ["reloadxml", "sofia profile internal-webrtc flush_inbound_reg agent.remove@dialer.local"],
      errors: [
        { command: "reloadxml", message: "ESL unavailable" },
        {
          command: "sofia profile internal-webrtc flush_inbound_reg agent.remove@dialer.local",
          message: "ESL unavailable"
        }
      ],
      skipped: false
    });
  });

  it("reconciles active directory files and removes inactive ones", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "outbound-dialer-fs-"));
    const config = createConfig(tempDir);
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("where users.is_active = true")) {
          return {
            rows: [
              {
                sip_username: "agent_active",
                sip_password_encrypted: encryptSecret(config, "active-secret"),
                display_name: "Active Agent"
              }
            ],
            rowCount: 1
          };
        }
        if (sql.includes("where users.is_active = false")) {
          return { rows: [{ sip_username: "agent_inactive" }], rowCount: 1 };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }
    } as unknown as pg.Pool;

    try {
      await provisionAgentDirectory(config, {
        sipUsername: "agent_inactive",
        sipPassword: "old-secret",
        displayName: "Inactive Agent"
      });

      const result = await reconcileAgentDirectories(pool, config);

      assert.deepEqual(result, { provisioned: 1, removed: 1, refreshErrors: 0 });
      assert.match(
        await readFile(join(tempDir, "directory", "default", "agent_active.xml"), "utf8"),
        /active-secret/
      );
      await assertFileMissing(join(tempDir, "directory", "default", "agent_inactive.xml"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createConfig(generatedConfigDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    FREESWITCH_GENERATED_CONFIG_DIR: generatedConfigDir,
    FREESWITCH_DOMAIN: "dialer.local",
    FREESWITCH_ESL_ENABLED: false,
    JWT_SECRET: "test-jwt-secret-that-is-at-least-32-bytes",
    SIP_SECRET_WRITE_VERSION: "v1",
    ...overrides
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
