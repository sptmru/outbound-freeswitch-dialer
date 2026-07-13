#!/usr/bin/env node

const baseUrl = (process.env.LOAD_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const token = process.env.LOAD_AUTH_TOKEN?.trim();
const concurrency = positiveInteger("LOAD_CONCURRENCY", 10);
const durationSeconds = positiveInteger("LOAD_DURATION_SECONDS", 30);
const maximumErrorRate = positiveNumber("LOAD_MAX_ERROR_RATE", 0.01);
const maximumP95Milliseconds = positiveInteger("LOAD_MAX_P95_MS", 750);

if (!token) {
  throw new Error("Set LOAD_AUTH_TOKEN to a non-production test agent JWT");
}

const deadline = Date.now() + durationSeconds * 1000;
const latencies = [];
let failures = 0;
let requests = 0;

await Promise.all(Array.from({ length: concurrency }, () => worker()));

latencies.sort((left, right) => left - right);
const errorRate = requests ? failures / requests : 1;
const p50 = percentile(latencies, 0.5);
const p95 = percentile(latencies, 0.95);
const requestsPerSecond = requests / durationSeconds;

console.log(
  JSON.stringify(
    {
      concurrency,
      durationSeconds,
      errorRate,
      failures,
      p50Milliseconds: p50,
      p95Milliseconds: p95,
      requests,
      requestsPerSecond
    },
    null,
    2
  )
);

if (errorRate > maximumErrorRate || p95 > maximumP95Milliseconds) {
  process.exitCode = 1;
}

async function worker() {
  while (Date.now() < deadline) {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${baseUrl}/agent/desk`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) {
        failures += 1;
      }
      await response.arrayBuffer();
    } catch {
      failures += 1;
    } finally {
      requests += 1;
      latencies.push(performance.now() - startedAt);
    }
  }
}

function percentile(values, fraction) {
  if (!values.length) return Number.POSITIVE_INFINITY;
  return Math.round(values[Math.min(values.length - 1, Math.floor(values.length * fraction))] * 100) / 100;
}

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveNumber(name, fallback) {
  const value = Number.parseFloat(process.env[name] ?? String(fallback));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be zero or greater`);
  return value;
}
