import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AppConfig } from "./config.js";
import {
  deleteAgentDirectory,
  ensureAgentDirectory,
  provisionAgentDirectory,
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

    const result = await refreshDeletedAgentRegistrations(config, ["agent.remove", "agent.remove"], async (_config, command) => {
      commands.push(command);
    });

    assert.deepEqual(commands, [
      "reloadxml",
      "sofia profile internal-webrtc flush_inbound_reg agent.remove@dialer.local"
    ]);
    assert.deepEqual(result, { commands, errors: [], skipped: false });
  });

  it("skips deleted registration refresh when ESL is disabled", async () => {
    const result = await refreshDeletedAgentRegistrations(createConfig("/tmp/outbound-dialer-test"), ["agent.remove"], async () => {
      throw new Error("ESL should not be called");
    });

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
});

function createConfig(generatedConfigDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    FREESWITCH_GENERATED_CONFIG_DIR: generatedConfigDir,
    FREESWITCH_DOMAIN: "dialer.local",
    FREESWITCH_ESL_ENABLED: false,
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
