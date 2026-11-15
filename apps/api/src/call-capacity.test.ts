import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capacityFailureContinuation,
  defaultCapacityLimits,
  validateCapacityLimits
} from "./call-capacity.js";

test("C02.3 capacity overflow is finite, cannot forward recursively or play without a retained channel/deadline", () => {
  const base = {
    admitted: true,
    customerClaimRetained: true,
    nextAction: "play_audio",
    now: 100,
    deadline: 30100
  };
  assert.equal(capacityFailureContinuation(base), "play_audio");
  assert.equal(capacityFailureContinuation({ ...base, admitted: false }), "reject");
  for (const change of [
    { customerClaimRetained: false },
    { nextAction: "forward" },
    { nextAction: "flow" },
    { deadline: 100 },
    { deadline: 90101 },
    { deadline: NaN }
  ])
    assert.equal(capacityFailureContinuation({ ...base, ...change }), "hangup");
});

test("C02 policy validates A06 ranges and preserves FS pre-admission headroom", () => {
  assert.deepEqual(validateCapacityLimits(defaultCapacityLimits), defaultCapacityLimits);
  const maxima = {
    queue: 200,
    channels: 184,
    trunk: 64,
    forwarding: 8,
    supervisor: 8,
    transferOverlap: 8,
    fsChannels: 200,
    fsTrunk: 80,
    preAdmission: 16
  };
  assert.deepEqual(validateCapacityLimits(maxima), maxima);
  for (const key of Object.keys(defaultCapacityLimits))
    for (const n of [0, -1, 1.5, NaN, Infinity, 1000, "2", null, undefined])
      assert.throws(
        () => validateCapacityLimits({ ...defaultCapacityLimits, [key]: n }),
        /invalid_capacity_limits/
      );
  assert.throws(
    () => validateCapacityLimits({ ...defaultCapacityLimits, extra: 1 }),
    /invalid_capacity_limits/
  );
  assert.throws(
    () => validateCapacityLimits({ ...defaultCapacityLimits, channels: 73 }),
    /pre_admission_headroom/
  );
  assert.throws(
    () => validateCapacityLimits({ ...defaultCapacityLimits, trunk: 33 }),
    /pre_admission_headroom/
  );
});
