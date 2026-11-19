import assert from "node:assert/strict";
import test from "node:test";
import {
  loadMeasurements,
  offerAtRate,
  seededOrder,
  summarizeLatency
} from "../scripts/inbound-load-measurements.mjs";

test("I03.5 retained timing includes scheduler delay, rejections and exceptions", async () => {
  let now = 11;
  const { measure, samples } = loadMeasurements(() => now);
  await measure(
    "admission",
    async () => {
      now = 20;
      return null;
    },
    0,
    () => "rejected"
  );
  await assert.rejects(
    measure(
      "admission",
      async () => {
        now = 72;
        throw new Error("acquisition");
      },
      12
    ),
    /acquisition/
  );
  assert.deepEqual(samples.admission, [
    { ms: 20, outcome: "rejected" },
    { ms: 60, outcome: "error" }
  ]);
  assert.deepEqual(summarizeLatency(samples.admission, [100, 250]), {
    count: 2,
    p95: 60,
    p99: 60,
    max: 60,
    outcomes: { rejected: 1, error: 1 },
    status: "failed"
  });
});

test("I03.5 nearest-rank budgets include all expected outcomes and missing evidence", () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ ms: i + 1, outcome: "rejected" }));
  assert.equal(summarizeLatency(samples, [95, 99]).status, "passed");
  assert.equal(summarizeLatency(samples, [94, 99]).status, "failed");
  assert.equal(summarizeLatency(samples, [95, 98]).status, "failed");
  assert.deepEqual(summarizeLatency([], [100, 250]), { count: 0, status: "missing" });
  assert.throws(() => summarizeLatency([{ ms: NaN, outcome: "ok" }]), /Invalid latency/);
});

test("I03.5 offer scheduling keeps the plan after a failure and seed preserves one of each claimant", async () => {
  const actors = [0, 1, 2, 3, 4, 5];
  const order = seededOrder(actors, 606);
  assert.deepEqual(order, seededOrder(actors, 606));
  assert.notDeepEqual(order, actors);
  assert.deepEqual([...order].sort(), actors);
  const results = await offerAtRate({
    count: 3,
    perSecond: 500,
    clock: () => 100,
    work: async (index, due) => {
      if (index === 1) throw new Error("fixture failure");
      return [index, due];
    }
  });
  assert.deepEqual(
    results.map(({ status }) => status),
    ["fulfilled", "rejected", "fulfilled"]
  );
  assert.deepEqual(results[2].value, [2, 104]);
});
