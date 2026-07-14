import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(rootDirectory, "scripts", "load-sip-rtp.mjs");

test("SIP/RTP load script is hard-wired to local FreeSWITCH echo", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /user\/\$\{agent\.sipUsername\}@\$\{agent\.domain\} &echo\(\)/);
  assert.doesNotMatch(source, /sofia\/(?:external|gateway)/);
  assert.match(source, /SIP_RTP_RUN_CONFIRM/);
});

test("SIP/RTP load script requires explicit local-media confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-sip-rtp-confirm-"));
  try {
    const tokensFile = join(directory, "tokens");
    await writeFile(tokensFile, "test-token\n", { mode: 0o600 });
    const result = runScript({
      FREESWITCH_ESL_PASSWORD: "test",
      LOAD_AUTH_TOKENS_FILE: tokensFile,
      LOAD_BASE_URL: "http://127.0.0.1:1/api"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SIP_RTP_RUN_CONFIRM=local-freeswitch-echo/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("SIP/RTP load script rejects an exposed token file before network access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-sip-rtp-tokens-"));
  try {
    const tokensFile = join(directory, "tokens");
    await writeFile(tokensFile, "test-token\n");
    await chmod(tokensFile, 0o644);
    const result = runScript({
      FREESWITCH_ESL_PASSWORD: "test",
      LOAD_AUTH_TOKENS_FILE: tokensFile,
      LOAD_BASE_URL: "http://127.0.0.1:1/api",
      SIP_RTP_RUN_CONFIRM: "local-freeswitch-echo"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LOAD_AUTH_TOKENS_FILE must have mode 600/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

function runScript(environment) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: rootDirectory,
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
}
