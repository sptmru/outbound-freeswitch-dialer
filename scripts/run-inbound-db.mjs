import { spawn } from "node:child_process";
import { prepareInboundArtifacts, testDatabaseUrl } from "../tests/fixtures/inbound/database.mjs";

// Check before compiling or spawning: dedicated execution must never silently skip.
try {
  testDatabaseUrl();
  await prepareInboundArtifacts();
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
      "--test-reporter=tap",
      ...(process.env.INBOUND_TEST_PATTERN ? ["--test-name-pattern", process.env.INBOUND_TEST_PATTERN] : []),
      "apps/api/dist-test/inbound-harness.integration.test.js",
      "apps/api/dist-test/dashboard/retention.integration.test.js",
      "apps/api/dist-test/call-recording.integration.test.js",
      "apps/api/dist-test/call-history.integration.test.js",
      "apps/api/dist-test/inbound-recovery.integration.test.js",
      "apps/api/dist-test/command-recovery.integration.test.js",
      "apps/api/dist-test/inbound-config.integration.test.js",
      "apps/api/dist-test/inbound-admin.integration.test.js",
      "apps/api/dist-test/inbound-audio.integration.test.js",
      "apps/api/dist-test/inbound-fallback.integration.test.js",
      "apps/api/dist-test/inbound-ingress.integration.test.js",
      "apps/api/dist-test/inbound-queue.integration.test.js",
      "apps/api/dist-test/inbound-dispatcher.integration.test.js",
      "apps/api/dist-test/inbound-acceptance.integration.test.js",
      "apps/api/dist-test/transfer-offers.integration.test.js",
      "apps/api/dist-test/transfer-connection.integration.test.js",
      "apps/api/dist-test/post-transfer.integration.test.js",
      "apps/api/dist-test/call-admission.integration.test.js",
      "apps/api/dist-test/eligibility.integration.test.js",
      "apps/api/dist-test/desk-sessions.integration.test.js",
      "apps/api/dist-test/service-invites.integration.test.js",
      "apps/api/dist-test/supervisor-coordination.integration.test.js",
      "apps/api/dist-test/call-capacity.integration.test.js",
      "apps/api/dist-test/call-executor.integration.test.js",
      "apps/api/dist-test/manual-outbound.integration.test.js",
      "apps/api/dist-test/auto-next.integration.test.js",
      "apps/api/dist-test/call-cleanup.integration.test.js",
      "apps/api/dist-test/native-call-control.integration.test.js",
      "apps/api/dist-test/inbound-schema.integration.test.js",
      "apps/api/dist-test/desk-slots-schema.integration.test.js",
      "apps/api/dist-test/call-participation.integration.test.js",
      "apps/api/dist-test/durable-call-work.integration.test.js",
      "apps/api/dist-test/call-coordination-legacy.integration.test.js",
      "apps/api/dist-test/coordination-cutover.integration.test.js"
    ]
  ]
];
for (const [command, args] of commands) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    // CI runs this growing PostgreSQL matrix serially. Keep a separate suite
    // deadline so the individual test and transaction budgets still apply.
    const timeoutMs = args[0] === "--test" ? 1_200_000 : 480_000;
    const timer = setTimeout(() => {
      console.error(`Inbound DB command timed out after ${timeoutMs / 1000}s: ${command} ${args[0]}`);
      child.kill("SIGKILL");
    }, timeoutMs);
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
