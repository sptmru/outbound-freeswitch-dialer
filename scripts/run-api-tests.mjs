import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { prepareInboundArtifacts } from "../tests/fixtures/inbound/database.mjs";

export async function apiTestArgs(directory, env = process.env) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(path);
    }
  }
  await visit(resolve(directory));
  assert.ok(files.length, "No compiled API tests discovered");
  // Existing migration suites share a database. Concurrent schema bootstrap can
  // deadlock CREATE INDEX CONCURRENTLY against another migration-lock waiter.
  // Serialize files only; controlled races inside each suite still use real concurrency.
  return ["--test", ...(env.TEST_DATABASE_URL ? ["--test-concurrency=1"] : []), ...files.sort()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = await apiTestArgs(process.argv[2] ?? "dist-test");
  if (process.env.TEST_DATABASE_URL) await prepareInboundArtifacts();
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
