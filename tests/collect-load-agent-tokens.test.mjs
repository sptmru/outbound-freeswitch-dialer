import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));

test("token collector validates every email before asking for a password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-token-emails-"));
  try {
    const emailsFile = join(directory, "emails");
    await writeFile(emailsFile, "agent@example.test\nnot-an-email\n");
    const result = runCollector([emailsFile, join(directory, "tokens")], {
      LOAD_BASE_URL: "http://127.0.0.1:1"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid email\(s\): not-an-email/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("token collector rejects an exposed password file before login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-token-password-"));
  try {
    const emailsFile = join(directory, "emails");
    const passwordFile = join(directory, "password");
    await writeFile(emailsFile, "agent@example.test\n");
    await writeFile(passwordFile, "test-password\n");
    await chmod(passwordFile, 0o644);
    const result = runCollector([emailsFile, join(directory, "tokens")], {
      LOAD_AGENT_PASSWORD_FILE: passwordFile,
      LOAD_BASE_URL: "http://127.0.0.1:1"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOAD_AGENT_PASSWORD_FILE.*chmod 600/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("token collector requires exact approval for a remote target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-token-target-"));
  try {
    const emailsFile = join(directory, "emails");
    await writeFile(emailsFile, "agent@example.test\n");
    const result = runCollector([emailsFile, join(directory, "tokens")], {
      LOAD_APPROVED_TARGET: "https://different.example/api",
      LOAD_BASE_URL: "https://client.example/api"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Set LOAD_APPROVED_TARGET exactly/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

function runCollector(argumentsList, environment = {}) {
  return spawnSync(process.execPath, ["scripts/collect-load-agent-tokens.mjs", ...argumentsList], {
    cwd: rootDirectory,
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
}
