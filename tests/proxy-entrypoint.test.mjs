import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const entrypoint = join(rootDirectory, "infra", "proxy", "entrypoint.sh");

test("proxy entrypoint accepts nginx-compatible positive body-size values", () => {
  for (const value of ["1", "1024k", "70m", "2G"]) {
    const result = validate(value);
    assert.equal(result.status, 0, `${value}: ${result.stderr || result.stdout}`);
  }
});

test("proxy entrypoint rejects unsafe or malformed body-size values before rendering nginx config", () => {
  for (const value of ["0", "-1", "00m", "1.5m", "70mb", "70 m", "70m;"]) {
    const result = validate(value);
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /Invalid PROXY_MAX_REQUEST_BODY_SIZE/);
  }
});

test("proxy entrypoint keeps the production-safe 70m default", () => {
  const result = spawnSync("sh", [entrypoint], {
    encoding: "utf8",
    env: {
      ...process.env,
      OUTBOUND_DIALER_PROXY_VALIDATE_ONLY: "true",
      PROXY_MAX_REQUEST_BODY_SIZE: ""
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

function validate(value) {
  return spawnSync("sh", [entrypoint], {
    encoding: "utf8",
    env: {
      ...process.env,
      OUTBOUND_DIALER_PROXY_VALIDATE_ONLY: "true",
      PROXY_MAX_REQUEST_BODY_SIZE: value
    }
  });
}
