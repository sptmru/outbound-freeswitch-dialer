import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));

test("agent desk load runner rejects an unsupported profile before making requests", () => {
  const result = spawnSync(process.execPath, ["scripts/load-agent-desk.mjs"], {
    cwd: rootDirectory,
    encoding: "utf8",
    env: { ...process.env, LOAD_AUTH_TOKEN: "not-used", LOAD_PROFILE: "unknown" }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LOAD_PROFILE must be steady or saturation/);
});

test("agent desk load runner requires dedicated test credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/load-agent-desk.mjs"], {
    cwd: rootDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      LOAD_AUTH_TOKEN: "",
      LOAD_AUTH_TOKENS_FILE: "",
      LOAD_BASE_URL: "http://127.0.0.1:1"
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LOAD_AUTH_TOKEN or LOAD_AUTH_TOKENS_FILE/);
});

test("load suite refuses a remote target without an exact approval match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-load-suite-"));
  const tokenFile = join(directory, "tokens");
  const nodeScript = join(directory, "node");
  try {
    await writeFile(tokenFile, "test-token\n", { mode: 0o600 });
    await writeFile(nodeScript, "#!/bin/sh\necho node-must-not-run >&2\nexit 99\n");
    await chmod(nodeScript, 0o755);
    const result = spawnSync("bash", ["scripts/run-load-suite.sh"], {
      cwd: rootDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        LOAD_APPROVED_TARGET: "https://different.example/api",
        LOAD_AUTH_TOKENS_FILE: tokenFile,
        LOAD_BASE_URL: "https://client.example/api",
        PATH: `${directory}:${process.env.PATH}`
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Remote target safety check failed/);
    assert.doesNotMatch(result.stderr, /node-must-not-run/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
