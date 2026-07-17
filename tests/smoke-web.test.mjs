import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const smokeScript = join(rootDirectory, "scripts", "smoke-web.sh");

test("web smoke retries a transient TLS failure before validating the published app", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-smoke-web-"));
  const curlScript = join(directory, "curl");
  const countFile = join(directory, "curl-count");

  try {
    await writeFile(
      curlScript,
      `#!/bin/sh
count=0
if [ -f "$FAKE_CURL_COUNT_FILE" ]; then
  count="$(cat "$FAKE_CURL_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s' "$count" > "$FAKE_CURL_COUNT_FILE"
if [ "$count" -eq 1 ]; then
  echo 'curl: (60) SSL certificate OpenSSL verify result: self-signed certificate (18)' >&2
  exit 60
fi
for argument do
  url="$argument"
done
case "$url" in
  */api/health/ready) printf '%s' '{"status":"ok","service":"api","checks":{}}' ;;
  *) printf '%s' '<div id="root"></div><script src="/assets/index-test.js"></script>' ;;
esac
`
    );
    await chmod(curlScript, 0o755);

    const result = spawnSync("bash", [smokeScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CURL_COUNT_FILE: countFile,
        PATH: `${directory}:${process.env.PATH}`,
        WEB_SMOKE_RETRY_ATTEMPTS: "3",
        WEB_SMOKE_RETRY_DELAY_SECONDS: "0",
        WEB_SMOKE_URL: "https://dialer.example.test"
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Published web smoke passed/);
    assert.equal(await readFile(countFile, "utf8"), "3");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
