#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const config = await loadConfig(process.env);
const tokens = await loadTokens(config);
const measurements = [];
const statusCounts = new Map();
let transportFailures = 0;
let requests = 0;
let bytesReceived = 0;

await validateTokens(tokens, config);

const startedAt = new Date();
const deadline = Date.now() + config.durationSeconds * 1000;
const sse = createSseStats(config.sseConnections);
const sseControllers = Array.from({ length: config.sseConnections }, () => new AbortController());
const sseTasks = sseControllers.map((controller, index) =>
  runSseConnection(tokens[index % tokens.length], controller, sse, config, deadline)
);

const workerTasks = Array.from({ length: config.concurrency }, (_, index) =>
  runDeskWorker(tokens[index % tokens.length], index)
);

await Promise.all(workerTasks);
await sleep(Math.max(0, deadline - Date.now()));
for (const controller of sseControllers) controller.abort();
await Promise.allSettled(sseTasks);

measurements.sort((left, right) => left - right);
const endedAt = new Date();
const actualDurationSeconds = Math.max(0.001, (endedAt.getTime() - startedAt.getTime()) / 1000);
const failures =
  transportFailures +
  [...statusCounts.entries()].reduce(
    (total, [status, count]) => total + (status >= 200 && status < 300 ? 0 : count),
    0
  );
const errorRate = requests ? failures / requests : 1;
const sseReadyRate = config.sseConnections ? sse.ready / config.sseConnections : 1;
const result = {
  schemaVersion: 1,
  target: config.baseUrl,
  profile: config.profile,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  configuredDurationSeconds: config.durationSeconds,
  actualDurationSeconds: round(actualDurationSeconds),
  concurrency: config.concurrency,
  pollIntervalMilliseconds: config.pollIntervalMilliseconds,
  sseConnections: config.sseConnections,
  uniqueTokens: tokens.length,
  http: {
    requests,
    requestsPerSecond: round(requests / actualDurationSeconds),
    bytesReceived,
    failures,
    transportFailures,
    errorRate: round(errorRate, 6),
    statusCounts: Object.fromEntries([...statusCounts.entries()].sort(([left], [right]) => left - right)),
    latencyMilliseconds: {
      p50: percentile(measurements, 0.5),
      p95: percentile(measurements, 0.95),
      p99: percentile(measurements, 0.99),
      max: measurements.length ? round(measurements.at(-1)) : null
    }
  },
  sse: {
    attempted: config.sseConnections,
    ready: sse.ready,
    readyRate: round(sseReadyRate, 6),
    refreshEvents: sse.refreshEvents,
    heartbeats: sse.heartbeats,
    unexpectedDisconnects: sse.unexpectedDisconnects,
    failures: sse.failures,
    statusCounts: Object.fromEntries([...sse.statusCounts.entries()].sort(([left], [right]) => left - right))
  },
  thresholds: {
    maximumErrorRate: config.maximumErrorRate,
    maximumP95Milliseconds: config.maximumP95Milliseconds,
    maximumP99Milliseconds: config.maximumP99Milliseconds,
    minimumSseReadyRate: config.minimumSseReadyRate,
    maximumSseDisconnects: config.maximumSseDisconnects
  }
};

const violations = [];
if (errorRate > config.maximumErrorRate) {
  violations.push(`HTTP error rate ${round(errorRate, 6)} exceeds ${config.maximumErrorRate}`);
}
if (percentile(measurements, 0.95) > config.maximumP95Milliseconds) {
  violations.push(`HTTP p95 exceeds ${config.maximumP95Milliseconds} ms`);
}
if (percentile(measurements, 0.99) > config.maximumP99Milliseconds) {
  violations.push(`HTTP p99 exceeds ${config.maximumP99Milliseconds} ms`);
}
if (sseReadyRate < config.minimumSseReadyRate) {
  violations.push(`SSE ready rate ${round(sseReadyRate, 6)} is below ${config.minimumSseReadyRate}`);
}
if (sse.unexpectedDisconnects > config.maximumSseDisconnects) {
  violations.push(`SSE disconnects ${sse.unexpectedDisconnects} exceed ${config.maximumSseDisconnects}`);
}

result.passed = violations.length === 0;
result.violations = violations;
const output = `${JSON.stringify(result, null, 2)}\n`;
process.stdout.write(output);

if (config.reportPath) {
  const reportPath = resolve(config.reportPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, output, { mode: 0o600 });
}

if (!result.passed) process.exitCode = 1;

async function runDeskWorker(token, workerIndex) {
  if (config.profile === "steady") {
    await sleep(Math.floor((workerIndex * config.pollIntervalMilliseconds) / config.concurrency));
  }

  while (Date.now() < deadline) {
    const requestStartedAt = performance.now();
    try {
      const response = await fetch(`${config.baseUrl}/agent/desk`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(config.requestTimeoutMilliseconds)
      });
      statusCounts.set(response.status, (statusCounts.get(response.status) ?? 0) + 1);
      const body = await response.arrayBuffer();
      bytesReceived += body.byteLength;
    } catch {
      transportFailures += 1;
    } finally {
      requests += 1;
      measurements.push(performance.now() - requestStartedAt);
    }

    if (config.profile === "steady") {
      const jitter = config.pollJitterMilliseconds
        ? Math.floor(Math.random() * (config.pollJitterMilliseconds * 2 + 1)) - config.pollJitterMilliseconds
        : 0;
      await sleep(Math.max(0, config.pollIntervalMilliseconds + jitter));
    }
  }
}

async function runSseConnection(token, controller, stats, currentConfig, currentDeadline) {
  try {
    const response = await fetch(`${currentConfig.baseUrl}/agent/events`, {
      headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    stats.statusCounts.set(response.status, (stats.statusCounts.get(response.status) ?? 0) + 1);
    if (!response.ok || !response.body) {
      stats.failures += 1;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawReady = false;
    while (Date.now() < currentDeadline) {
      const remaining = currentDeadline - Date.now();
      const read = reader.read();
      const outcome = await Promise.race([read, sleep(Math.max(1, remaining)).then(() => ({ done: true }))]);
      if (outcome.done) break;
      buffer += decoder.decode(outcome.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.includes("event: ready")) {
          if (!sawReady) stats.ready += 1;
          sawReady = true;
        }
        if (frame.includes("event: refresh")) stats.refreshEvents += 1;
        if (frame.startsWith(":")) stats.heartbeats += 1;
      }
    }
    if (!sawReady) stats.failures += 1;
    if (Date.now() + 100 < currentDeadline && !controller.signal.aborted) stats.unexpectedDisconnects += 1;
  } catch {
    if (!controller.signal.aborted) {
      stats.failures += 1;
      if (Date.now() + 100 < currentDeadline) stats.unexpectedDisconnects += 1;
    }
  }
}

async function validateTokens(currentTokens, currentConfig) {
  const statuses = await Promise.all(
    currentTokens.map(async (token) => {
      try {
        const response = await fetch(`${currentConfig.baseUrl}/auth/me`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(currentConfig.requestTimeoutMilliseconds)
        });
        await response.arrayBuffer();
        return response.status;
      } catch {
        return 0;
      }
    })
  );
  const invalid = statuses.filter((status) => status < 200 || status >= 300);
  if (invalid.length) {
    throw new Error(
      `Token preflight failed for ${invalid.length}/${currentTokens.length} token(s): ${invalid.join(", ")}`
    );
  }
}

async function loadTokens(currentConfig) {
  const values = [];
  if (currentConfig.token) values.push(currentConfig.token);
  if (currentConfig.tokensFile) {
    const file = await stat(currentConfig.tokensFile);
    if ((file.mode & 0o077) !== 0) {
      throw new Error(
        "LOAD_AUTH_TOKENS_FILE must not be readable or writable by group/other users; run chmod 600"
      );
    }
    const contents = await readFile(currentConfig.tokensFile, "utf8");
    values.push(
      ...contents
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
    );
  }
  const unique = [...new Set(values)];
  if (!unique.length) {
    throw new Error(
      "Set LOAD_AUTH_TOKEN or LOAD_AUTH_TOKENS_FILE to dedicated non-production test agent JWTs"
    );
  }
  if (unique.length > currentConfig.maximumTokens) {
    throw new Error(`Load token count must not exceed ${currentConfig.maximumTokens}`);
  }
  return unique;
}

async function loadConfig(environment) {
  const profile = environment.LOAD_PROFILE?.trim() || "steady";
  if (!new Set(["steady", "saturation"]).has(profile)) {
    throw new Error("LOAD_PROFILE must be steady or saturation");
  }
  const baseUrl = (environment.LOAD_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const parsedUrl = new URL(baseUrl);
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
    throw new Error("LOAD_BASE_URL must use http or https");
  }
  const approvedTarget = environment.LOAD_APPROVED_TARGET?.trim().replace(/\/$/, "");
  if (!isLoopback(parsedUrl.hostname) && approvedTarget !== baseUrl) {
    throw new Error(`Set LOAD_APPROVED_TARGET exactly to ${baseUrl}`);
  }

  const concurrency = boundedPositiveInteger(environment, "LOAD_CONCURRENCY", 10, 100);
  const durationSeconds = boundedPositiveInteger(environment, "LOAD_DURATION_SECONDS", 30, 21_600);
  const pollIntervalMilliseconds = boundedNonNegativeInteger(
    environment,
    "LOAD_POLL_INTERVAL_MS",
    2000,
    60_000
  );
  if (profile === "steady" && pollIntervalMilliseconds < 250) {
    throw new Error("LOAD_POLL_INTERVAL_MS must be at least 250 for the steady profile");
  }
  return {
    baseUrl,
    token: environment.LOAD_AUTH_TOKEN?.trim(),
    tokensFile: environment.LOAD_AUTH_TOKENS_FILE?.trim(),
    reportPath: environment.LOAD_REPORT_PATH?.trim(),
    profile,
    concurrency,
    durationSeconds,
    pollIntervalMilliseconds,
    pollJitterMilliseconds: boundedNonNegativeInteger(environment, "LOAD_POLL_JITTER_MS", 250, 60_000),
    requestTimeoutMilliseconds: boundedPositiveInteger(environment, "LOAD_REQUEST_TIMEOUT_MS", 5000, 60_000),
    sseConnections: boundedNonNegativeInteger(
      environment,
      "LOAD_SSE_CONNECTIONS",
      profile === "steady" ? concurrency : 0,
      100
    ),
    maximumTokens: 100,
    maximumErrorRate: nonNegativeNumber(environment, "LOAD_MAX_ERROR_RATE", 0.01),
    maximumP95Milliseconds: positiveInteger(environment, "LOAD_MAX_P95_MS", 750),
    maximumP99Milliseconds: positiveInteger(environment, "LOAD_MAX_P99_MS", 1500),
    minimumSseReadyRate: fraction(environment, "LOAD_MIN_SSE_READY_RATE", 0.99),
    maximumSseDisconnects: nonNegativeInteger(environment, "LOAD_MAX_SSE_DISCONNECTS", 0)
  };
}

function createSseStats(attempted) {
  return {
    attempted,
    ready: 0,
    refreshEvents: 0,
    heartbeats: 0,
    unexpectedDisconnects: 0,
    failures: 0,
    statusCounts: new Map()
  };
}

function percentile(values, fractionValue) {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const index = Math.min(values.length - 1, Math.ceil(values.length * fractionValue) - 1);
  return round(values[Math.max(0, index)]);
}

function positiveInteger(environment, name, fallback) {
  const value = Number.parseInt(environment[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boundedPositiveInteger(environment, name, fallback, maximum) {
  const value = positiveInteger(environment, name, fallback);
  if (value > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return value;
}

function nonNegativeInteger(environment, name, fallback) {
  const value = Number.parseInt(environment[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function boundedNonNegativeInteger(environment, name, fallback, maximum) {
  const value = nonNegativeInteger(environment, name, fallback);
  if (value > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return value;
}

function nonNegativeNumber(environment, name, fallback) {
  const value = Number.parseFloat(environment[name] ?? String(fallback));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be zero or greater`);
  return value;
}

function fraction(environment, name, fallback) {
  const value = nonNegativeNumber(environment, name, fallback);
  if (value > 1) throw new Error(`${name} must be between 0 and 1`);
  return value;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function round(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
