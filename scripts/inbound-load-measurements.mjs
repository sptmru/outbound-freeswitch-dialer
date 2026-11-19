import { setTimeout as delay } from "node:timers/promises";
import { budgets, percentile } from "./a06-budgets.mjs";

export const loadProfiles = {
  smoke: { agents: 20, seed: 606, burst: 20, arrivalRate: 5, arrivalSeconds: 2 },
  reference: { agents: 20, seed: 606, burst: 20, arrivalRate: 5, arrivalSeconds: 60 }
};

export const latencyLimits = {
  admission: [budgets.admissionP95Ms, budgets.admissionP99Ms],
  offerSnapshot: [budgets.offerP95Ms, budgets.offerP99Ms]
};

export function seededOrder(items, seed) {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const index = seed % (i + 1);
    [order[i], order[index]] = [order[index], order[i]];
  }
  return order;
}

export function loadMeasurements(clock = () => performance.now()) {
  const samples = {};
  async function measure(name, work, offeredAt = clock(), classify = () => "ok") {
    let outcome = "error";
    try {
      const result = await work();
      outcome = classify(result);
      return result;
    } finally {
      (samples[name] ??= []).push({ ms: clock() - offeredAt, outcome });
    }
  }
  return { samples, measure };
}

export function summarizeLatency(samples, limits) {
  if (!samples.length) return { count: 0, status: "missing" };
  const durations = samples.map((s) => s.ms);
  const outcomes = {};
  for (const { ms, outcome } of samples) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid latency sample");
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  const p95 = percentile(durations, 0.95);
  const p99 = percentile(durations, 0.99);
  const failed = outcomes.error || (limits && (p95 > limits[0] || p99 > limits[1]));
  return {
    count: samples.length,
    p95,
    p99,
    max: Math.max(...durations),
    outcomes,
    status: failed ? "failed" : "passed"
  };
}

// Every arrival has a planned timestamp independent of earlier completions.
export async function offerAtRate({ count, perSecond, work, clock = () => performance.now() }) {
  const start = clock();
  const tasks = Array.from({ length: count }, async (_, sequence) => {
    const due = start + (sequence * 1000) / perSecond;
    await delay(Math.max(0, due - clock()));
    return work(sequence, due);
  });
  return Promise.allSettled(tasks);
}
