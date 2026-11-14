import assert from "node:assert/strict";
import test from "node:test";
import {
  budgets,
  resources,
  validateBudgets,
  validateResourceLimits,
  capacityDecision,
  retryAt,
  percentile
} from "../scripts/a06-budgets.mjs";

test("A06.1 every finite resource rejects new usage at/above the limit without eviction", () => {
  for (const { limit } of Object.values(resources)) {
    assert.equal(capacityDecision([{ used: limit - 1, delta: 1, limit }]), true);
    for (const used of [limit, limit + 1]) {
      const claim = { used, delta: 1, limit };
      assert.equal(capacityDecision([claim]), false);
      assert.equal(claim.used, used);
      assert.equal(capacityDecision([{ used, delta: 0, limit }]), true);
    }
  }
  assert.equal(
    capacityDecision([
      { used: 39, delta: 1, limit: 40 },
      { used: 80, delta: 1, limit: 80 }
    ]),
    false
  );
  // A failed connection retains one queue return permit and an uncertain browser leg.
  assert.equal(
    capacityDecision([
      { used: 40, delta: 0, limit: 40 },
      { used: 80, delta: 1, limit: 80 }
    ]),
    false
  );
  assert.throws(() => capacityDecision([{ used: -1, delta: 1, limit: 40 }]));
});

test("A06.1 retries require cleanup and remaining original deadline, never expiry/ignore override", () => {
  const input = { attempt: 1, now: 1000, deadline: 60000, cleanupConfirmed: true };
  assert.equal(retryAt(input), 1500);
  assert.equal(retryAt({ ...input, attempt: 2 }), 2000);
  for (const extra of [
    { attempt: 3 },
    { uncertain: true },
    { excluded: true },
    { cleanupConfirmed: false },
    { deadline: 11499 }
  ])
    assert.equal(retryAt({ ...input, ...extra }), null);
  assert.equal(retryAt({ ...input, deadline: 11500 }), 1500);
});

test("A06.2 aggregate replica budget and protected reserves fail closed", () => {
  assert.deepEqual(validateBudgets(), { connections: 24, headroom: 63 });
  for (const extra of [
    { apiReplicas: 20 },
    { workerReplicas: 20 },
    { pgMax: 30 },
    { criticalPerWorker: 4 },
    { commandMs: 10000 },
    { acquireMs: 0 }
  ])
    assert.throws(() => validateBudgets({ ...budgets, ...extra }));
});

test("A06.1 FS headroom cannot be double-sold to DB and pre-admission", () => {
  const limits = validateResourceLimits();
  for (const [key, spec] of Object.entries(resources))
    assert.throws(() => validateResourceLimits({ ...limits, [key]: (spec.min ?? 1) - 1 }));
  for (const extra of [
    { channels: 73 },
    { trunk: 33 },
    { preAdmission: 9 },
    { journalMiB: 257 },
    { queue: NaN }
  ])
    assert.throws(() => validateResourceLimits({ ...limits, ...extra }));
});

test("A06.3 nearest-rank percentiles retain tail observations", () => {
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.95
    ),
    95
  );
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.99
    ),
    99
  );
  assert.throws(() => percentile([], 0.99));
});
