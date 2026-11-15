import { spawn } from "node:child_process";
import { testDatabaseUrl } from "../tests/fixtures/inbound/database.mjs";

// Check before compiling or spawning: dedicated execution must never silently skip.
try {
  testDatabaseUrl();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const commands = [
  ["npm", ["--workspace", "@outbound-dialer/shared", "run", "build"]],
  ["node", ["node_modules/typescript/bin/tsc", "-p", "apps/api/tsconfig.test.json"]],
  [
    "node",
    [
      "--test",
      "--test-concurrency=1",
      "apps/api/dist-test/inbound-harness.integration.test.js",
      "apps/api/dist-test/inbound-schema.integration.test.js",
      "apps/api/dist-test/desk-slots-schema.integration.test.js",
      "apps/api/dist-test/call-participation.integration.test.js",
      "apps/api/dist-test/durable-call-work.integration.test.js",
      "apps/api/dist-test/call-coordination-legacy.integration.test.js"
    ]
  ]
];
for (const [command, args] of commands) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolve(status ?? 1);
    });
  });
  if (code) process.exit(code);
}
