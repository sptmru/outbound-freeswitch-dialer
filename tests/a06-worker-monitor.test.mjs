import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { monitorWorker, assertWorkersHealthy } from "../scripts/a06-worker-monitor.mjs";

function launch(script) {
  return monitorWorker(
    spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"] }),
    { mode: "api", replica: 1 }
  );
}

test("A07.3 worker failure reaches parent before blocked cleanup can exit", { timeout: 5000 }, async () => {
  const handle = launch(
    `process.send({type:'failed',error:{message:'lock timeout',code:'55P03',context:{lane:'admission',stage:'admission-lock'}}}); process.on('message', () => process.exit(0));`
  );
  try {
    await once(handle.child, "message");
    assert.equal(handle.child.exitCode, null);
    assert.throws(() => assertWorkersHealthy([handle]), /55P03.*admission/);
    handle.child.send({ type: "stop" });
    await handle.ended;
  } finally {
    if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
    await handle.ended;
  }
});

test("A07.3 unexpected worker exit preserves stderr and fails at checkpoint", { timeout: 5000 }, async () => {
  const handle = launch("process.stderr.write('fixture SQL failure'); process.exit(19)");
  await handle.ended;
  assert.equal(handle.state.code, 19);
  assert.throws(() => assertWorkersHealthy([handle]), /fixture SQL failure/);
});

test("A07.3 completed worker exits cleanly without becoming a failure", { timeout: 5000 }, async () => {
  const handle = launch("process.exit(0)");
  await handle.ended;
  assert.doesNotThrow(() => assertWorkersHealthy([handle]));
});

test("A07.4 invalid storage mode fails before allocating Docker fixtures", () => {
  const result = spawnSync("bash", ["scripts/test-a06-budgets.sh"], {
    env: { PATH: process.env.PATH, A06_PG_STORAGE: "unsupported" },
    encoding: "utf8",
    timeout: 5000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /A06_PG_STORAGE must be tmpfs or volume/);
  assert.doesNotMatch(result.stdout, /artifacts:/);
});
