import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { availableParallelism, arch, totalmem, freemem } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { cleanupFixture } from "../tests/fixtures/inbound/cleanup.mjs";
import { databaseConfig, testDatabaseUrl } from "../tests/fixtures/inbound/database.mjs";
import { loadDesk, loadMutation } from "../tests/fixtures/inbound/load-desk.mjs";
import { registerDashboardRoutes } from "../apps/api/dist-test/dashboard/routes.js";
import { importIngressRecord } from "../apps/api/dist-test/inbound-ingress.js";
import { admitInboundQueue, persistInboundQueueEvent } from "../apps/api/dist-test/inbound-queue.js";
import { settleInboundConnection } from "../apps/api/dist-test/inbound-connection.js";
import {
  persistCoordinatedCallEvent,
  reconcileCoordinatedCallCleanup
} from "../apps/api/dist-test/call-cleanup.js";
import { dispatchInboundOffers } from "../apps/api/dist-test/inbound-dispatcher.js";
import { CAPACITY_SETTINGS_KEY } from "../apps/api/dist-test/call-capacity.js";
import { setAgentAvailability } from "../apps/api/dist-test/agent-availability.js";
import { metricsRegistry } from "../apps/api/dist-test/inbound-metrics.js";
import { budgets, resources } from "./a06-budgets.mjs";
import {
  latencyLimits,
  loadMeasurements,
  loadProfiles,
  offerAtRate,
  seededOrder,
  summarizeLatency
} from "./inbound-load-measurements.mjs";

const [profileName, directory] = process.argv.slice(2);
assert.ok(Object.hasOwn(loadProfiles, profileName));
assert.match(directory, /^\/tmp\/outbound-inbound-db\.[A-Za-z0-9]+$/);
const url = new URL(testDatabaseUrl());
assert.equal(url.searchParams.get("host"), join(directory, "socket"));
const profile = loadProfiles[profileName];
const report = {
  criteria: ["I03.1", "I03.2", "I03.3"],
  scope: "Fastify injection and PostgreSQL with simulated ingress and media; partial I03 workload",
  profile: profileName,
  inputs: profile,
  node: process.version,
  host: {
    architecture: arch(),
    cpus: availableParallelism(),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem()
  },
  startedAt: new Date().toISOString(),
  status: "running",
  scenarios: []
};
const save = () =>
  writeFile(join(directory, "i03-control.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const { samples, measure } = loadMeasurements();
const config = {
  JWT_SECRET: "i03-local-disposable-fixture-secret",
  JWT_EXPIRES_SECONDS: 3600,
  PUBLIC_APP_URL: "https://i03.example.test",
  DEFAULT_PHONE_COUNTRY_CODE: "US",
  CONTACT_MAX_ATTEMPTS: 3,
  CONTACT_RETRY_DELAY_SECONDS: 900,
  FREESWITCH_ESL_ENABLED: true,
  FREESWITCH_ESL_HOST: "127.0.0.1",
  FREESWITCH_ESL_PORT: 1,
  corsOrigins: []
};
let fixture, pool;
let resourceTimer;
const app = Fastify();
const wakeups = [];
const simulated = {
  async wakeExecutor(id) {
    wakeups.push(id);
  }
};
const one = (sql, params) => pool.query(sql, params).then((r) => r.rows[0]);
const journalId = randomUUID();
let sequence = 0;
const routes = new Map();
const limits = Object.fromEntries(
  [
    "queue",
    "channels",
    "trunk",
    "forwarding",
    "supervisor",
    "transferOverlap",
    "fsChannels",
    "fsTrunk",
    "preAdmission"
  ].map((key) => [key, resources[key].limit])
);
const configureLimits = (value) =>
  pool.query(
    `insert into system_settings(key,value_json) values($1,$2)
   on conflict (key) do update set value_json=excluded.value_json`,
    [CAPACITY_SETTINGS_KEY, value]
  );
async function event(id, name, headers = {}) {
  await persistInboundQueueEvent(pool, {
    variable_outbound_dialer_ingress_uuid: id,
    "unique-id": id,
    "event-name": name,
    "event-uuid": randomUUID(),
    ...headers
  });
}
const end = (id) => event(id, "CHANNEL_DESTROY", { "hangup-cause": "NORMAL_CLEARING" });
const snapshot = (desk) =>
  app.inject({
    method: "GET",
    url: `/agent/call-offers?deskSessionId=${desk.sessionId}`,
    headers: desk.headers
  });
const mutate = (desk, url, payload) => app.inject({ method: "POST", url, headers: desk.headers, payload });
async function resolve(id) {
  await pool.query(
    "update call_operations set state='succeeded',result='{}',resolved_at=clock_timestamp(),resolution_evidence='I03 simulated media' where id=$1 and resolved_at is null",
    [id]
  );
}
async function arrive(campaign, offeredAt = performance.now(), offerTimeoutMs = budgets.offerMs) {
  const route = routes.get(campaign);
  const id = randomUUID();
  const caller = `+1202555${String(100 + (++sequence % 100)).padStart(4, "0")}`;
  const record = {
    uuid: id,
    journalId,
    sequence,
    arrivedUs: Date.now() * 1000,
    did: route.did,
    routeRevision: "1",
    numberId: route.numberId,
    queueId: route.queueId,
    queueRevision: "1",
    campaignId: campaign,
    timeoutMs: budgets.queueMs,
    routeData: Buffer.from(
      JSON.stringify({
        queue_timeout_ms: budgets.queueMs,
        max_waiting_calls: limits.queue,
        offer_timeout_ms: offerTimeoutMs
      })
    ).toString("base64url"),
    callingNumber: caller,
    terminalUs: null,
    terminalReason: null
  };
  const op = await measure(
    "admission",
    async () => {
      await measure("ingressImport", () => importIngressRecord(pool, record));
      return measure("queueClaim", () => admitInboundQueue(pool, id));
    },
    offeredAt,
    (result) => (result ? "admitted" : "rejected")
  );
  if (!op) {
    assert.equal(
      (await one("select inbound_end_reason from calls where id=$1", [id])).inbound_end_reason,
      "capacity_exceeded"
    );
    return { id, admitted: false };
  }
  await event(id, "CUSTOM", {
    "event-subclass": "outbound_dialer::inbound_waiting_started",
    "outbound-dialer-operation-id": op.id
  });
  await resolve(op.id);
  return { id, admitted: true };
}
async function readOffers(desks) {
  const offeredAt = performance.now();
  return collect(
    desks.map(async (desk) => {
      const result = await measure(
        "offerSnapshot",
        async () => {
          await measure("offerDispatch", () => dispatchInboundOffers(pool, desk.id));
          return measure("offerRead", () => snapshot(desk));
        },
        offeredAt,
        (response) => (response.statusCode === 200 ? "ok" : "error")
      );
      assert.equal(result.statusCode, 200, result.body);
      return result.json().offer;
    })
  );
}
async function active() {
  return one(`select
    (select count(*)::int from calls where ended_at is null) as calls,
    (select count(*)::int from call_offers where state='pending') as offers,
    (select count(*)::int from agent_call_slots where state<>'free') as slots,
    (select count(*)::int from call_legs where ended_at is null) as legs,
    (select count(*)::int from call_capacity_reservations where state<>'released') as claims,
    (select count(*)::int from call_operations where resolved_at is null) as operations`);
}
async function scenario(name, work) {
  const result = { name, status: "running" };
  report.scenarios.push(result);
  const offsets = Object.fromEntries(Object.entries(samples).map(([key, value]) => [key, value.length]));
  try {
    result.evidence = await work();
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = error.stack;
    if (error instanceof AggregateError) result.errors = error.errors.map((cause) => cause.stack);
    throw error;
  } finally {
    result.latency = Object.fromEntries(
      Object.entries(samples)
        .map(([kind, rows]) => [kind, rows.slice(offsets[kind] ?? 0)])
        .filter(([, rows]) => rows.length)
        .map(([kind, rows]) => [kind, summarizeLatency(rows, latencyLimits[kind])])
    );
    await save();
  }
}
async function collect(tasks) {
  const results = await Promise.allSettled(tasks);
  const errors = results.filter((result) => result.status === "rejected");
  if (errors.length)
    throw new AggregateError(
      errors.map(({ reason }) => reason),
      `${errors.length} offered tasks failed`
    );
  return results.map(({ value }) => value);
}
let failure;
try {
  await save();
  fixture = await cleanupFixture(databaseConfig(url.href), {
    onPoolError(error) {
      report.poolError = error.message;
    }
  });
  ({ pool } = fixture);
  const { campaignId } = fixture;
  registerDashboardRoutes(
    app,
    config,
    pool,
    undefined,
    simulated,
    undefined,
    undefined,
    simulated,
    simulated
  );
  const monotonicStart = performance.now();
  report.pool = { max: pool.options.max, scope: "single fixture pool" };
  report.samplesOverTime = [];
  resourceTimer = setInterval(
    () =>
      report.samplesOverTime.push({
        elapsedMs: performance.now() - monotonicStart,
        runnerCpu: process.cpuUsage(),
        runnerRssBytes: process.memoryUsage.rss(),
        poolConnections: pool.totalCount,
        poolIdle: pool.idleCount,
        poolWaiters: pool.waitingCount
      }),
    250
  );
  report.postgres = await one(
    "select version(), current_setting('fsync') as fsync, current_setting('synchronous_commit') as synchronous_commit"
  );
  await configureLimits(limits);
  const other = (
    await one(
      "insert into campaigns(name,status,manual_dialing_enabled) values('I03 isolation','active',true) returning id"
    )
  ).id;
  const otherQueue = (
    await one("insert into inbound_queues(campaign_id,name) values($1,'I03 isolation') returning id", [other])
  ).id;
  routes.set(campaignId, {
    queueId: (await one("select id from inbound_queues where campaign_id=$1", [campaignId])).id,
    did: "+12025550100",
    numberId: randomUUID()
  });
  routes.set(other, { queueId: otherQueue, did: "+12025550101", numberId: randomUUID() });
  await scenario("open-loop arrivals at lowered capacity", async () => {
    assert.deepEqual(await active(), { calls: 0, offers: 0, slots: 0, legs: 0, claims: 0, operations: 0 });
    await configureLimits({ ...limits, queue: 4 });
    const results = await offerAtRate({
      count: profile.arrivalRate * profile.arrivalSeconds,
      perSecond: profile.arrivalRate,
      work: async (_index, due) => {
        const call = await arrive(campaignId, due);
        if (call.admitted) {
          await delay(1000);
          await end(call.id);
        }
        return call;
      }
    });
    const errors = results.filter(({ status }) => status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map(({ reason }) => reason),
        "Open-loop arrivals failed"
      );
    const admitted = results.filter(({ value }) => value.admitted).length;
    assert.ok(admitted > 0 && admitted < results.length, "Rate wave must admit and reject");
    return { admitted, rejected: results.length - admitted, total: results.length };
  });
  await configureLimits(limits);
  const desks = [];
  for (let i = 0; i < profile.agents; i++) desks.push(await loadDesk(pool, config, campaignId, `i03-${i}`));
  const isolation = await loadDesk(pool, config, other, "i03-isolation");
  await scenario("20-arrival burst, ring-all, competing accepts and replay", async () => {
    const offeredAt = performance.now();
    const calls = await collect(Array.from({ length: profile.burst }, () => arrive(campaignId, offeredAt)));
    assert.ok(calls.every((call) => call.admitted));
    const offers = await readOffers(desks);
    const callId = offers[0]?.callId;
    assert.ok(callId);
    assert.ok(offers.every((offer) => offer?.callId === callId));
    assert.equal((await active()).slots, 0);
    assert.equal((await active()).legs, profile.burst);
    assert.equal((await snapshot(isolation)).json().offer, null);
    const attempts = seededOrder(
      desks.map((desk, i) => ({
        desk,
        url: `/agent/call-offers/${offers[i].id}/accept`,
        payload: loadMutation(desk)
      })),
      profile.seed
    );
    const responses = await collect(
      attempts.map(async (attempt) => ({
        ...attempt,
        response: await measure(
          "accept",
          () => mutate(attempt.desk, attempt.url, attempt.payload),
          undefined,
          (response) =>
            response.statusCode === 200 ? "accepted" : response.statusCode === 409 ? "conflict" : "error"
        )
      }))
    );
    const winners = responses.filter(({ response }) => response.statusCode === 200);
    assert.equal(winners.length, 1);
    assert.ok(
      responses.every(
        ({ response }) =>
          response.statusCode === 200 ||
          (response.statusCode === 409 && response.json().code === "offer_closed")
      )
    );
    const [winner] = winners;
    const accepted = winner.response.json();
    const replay = await mutate(winner.desk, winner.url, winner.payload);
    assert.deepEqual(replay.json(), accepted);
    assert.ok(wakeups.every((id) => id === accepted.operationId));
    assert.deepEqual(
      await one(
        `select
      (select count(*)::int from call_offers where call_id=$1 and state='accepted') as winners,
      (select count(*)::int from inbound_connection_attempts where call_id=$1) as attempts,
      (select count(*)::int from call_legs where call_id=$1 and type='agent') as agent_legs,
      (select count(*)::int from agent_call_slots where call_id=$1) as slots,
      (select count(*)::int from call_execution_attempts) as physical_sends`,
        [callId]
      ),
      { winners: 1, attempts: 1, agent_legs: 1, slots: 1, physical_sends: 0 }
    );
    const attempt = await one(
      `select a.bridge_operation_id,l.freeswitch_uuid from inbound_connection_attempts a
      join call_legs l on l.call_id=a.call_id and l.participant_id=a.participant_id where a.call_id=$1`,
      [callId]
    );
    await pool.query(
      "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),0,0)",
      [attempt.bridge_operation_id, randomUUID()]
    );
    await resolve(attempt.bridge_operation_id);
    await event(callId, "CHANNEL_BRIDGE", { "other-leg-unique-id": attempt.freeswitch_uuid });
    assert.equal((await one("select state from calls where id=$1", [callId])).state, "agent_connected");
    const operations = await pool.query(
      "select id from call_operations where call_id=$1 and resolved_at is null",
      [callId]
    );
    for (const op of operations.rows) await resolve(op.id);
    await settleInboundConnection(pool, accepted.operationId);
    await end(callId);
    await persistCoordinatedCallEvent(pool, {
      callId,
      legUuid: attempt.freeswitch_uuid,
      eventName: "CHANNEL_HANGUP_COMPLETE",
      eventUuid: randomUUID()
    });
    await reconcileCoordinatedCallCleanup(pool, callId);
    for (const call of calls) if (call.id !== callId) await end(call.id);
    return {
      arrivals: calls.length,
      offers: offers.length,
      winners: winners.length,
      conflicts: responses.length - 1,
      callId
    };
  });
  await scenario("queue isolation, Ignore, pause, expiry and manual override", async () => {
    const [a, b, c, d, e] = desks;
    const call = await arrive(campaignId, undefined, 5000);
    const secondary = await arrive(other);
    const [aOffer, bOffer, cOffer, dOffer, eOffer, otherOffer] = await readOffers([a, b, c, d, e, isolation]);
    assert.equal(aOffer.callId, call.id);
    assert.equal(bOffer.callId, call.id);
    assert.equal(cOffer.callId, call.id);
    assert.equal(otherOffer.callId, secondary.id);
    const ignore = await mutate(a, `/agent/call-offers/${aOffer.id}/ignore`, loadMutation(a));
    assert.equal(ignore.statusCode, 200, ignore.body);
    assert.equal((await snapshot(a)).json().offer, null);
    assert.equal((await setAgentAvailability(pool, d.id, "paused")).status, "paused");
    assert.equal((await snapshot(d)).json().offer, null);
    assert.equal((await one("select state from call_offers where id=$1", [dOffer.id])).state, "canceled");
    const manual = () =>
      mutate(b, "/agent/manual-dial/start", {
        phoneNumber: "+12025550189",
        campaignId,
        intent: { ...loadMutation(b), startReason: "manual" }
      });
    const outbound = await manual();
    assert.equal(outbound.statusCode, 200, outbound.body);
    assert.deepEqual(await one("select state,reason from call_offers where id=$1", [bOffer.id]), {
      state: "ignored",
      reason: "manual_outbound_started"
    });
    const duplicate = await manual();
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal((await snapshot(c)).json().offer.id, cOffer.id);
    assert.equal((await snapshot(isolation)).json().offer.id, otherOffer.id);
    const finalized = await one(
      "select id from calls where direction='outbound' and agent_id=$1 and ended_at is null",
      [b.id]
    );
    assert.ok(finalized);
    const legs = await pool.query("select freeswitch_uuid from call_legs where call_id=$1", [finalized.id]);
    const ops = await pool.query("select id from call_operations where call_id=$1", [finalized.id]);
    for (const op of ops.rows) await resolve(op.id);
    for (const leg of legs.rows)
      await persistCoordinatedCallEvent(pool, {
        callId: finalized.id,
        legUuid: leg.freeswitch_uuid,
        eventName: "CHANNEL_HANGUP_COMPLETE",
        eventUuid: randomUUID()
      });
    await reconcileCoordinatedCallCleanup(pool, finalized.id);
    const expiresBy = performance.now() + 6000;
    while (
      !(await one("select deadline_at<=clock_timestamp() as due from call_offers where id=$1", [eOffer.id]))
        .due
    ) {
      assert.ok(performance.now() < expiresBy, "Short offer deadline did not elapse");
      await delay(25);
    }
    assert.equal((await snapshot(e)).json().offer, null);
    assert.equal(await dispatchInboundOffers(pool, e.id), null);
    assert.deepEqual(await one("select state,reason from call_offers where id=$1", [eOffer.id]), {
      state: "expired",
      reason: "deadline_elapsed"
    });
    await end(call.id);
    await end(secondary.id);
    assert.equal((await snapshot(c)).json().offer, null);
    assert.equal((await snapshot(isolation)).json().offer, null);
    return {
      ignoredOffer: aOffer.id,
      pausedOffer: dOffer.id,
      expiredOffer: eOffer.id,
      manualCall: finalized.id,
      unrelatedOffer: cOffer.id,
      isolatedOffer: otherOffer.id
    };
  });
  await scenario("lowered limits preserve existing claims and reject new work", async () => {
    await configureLimits(limits);
    const first = await arrive(campaignId);
    const second = await arrive(campaignId);
    assert.ok(first.admitted && second.admitted);
    const before = await active();
    await configureLimits({ ...limits, queue: 1 });
    const rejected = await arrive(campaignId);
    assert.equal(rejected.admitted, false);
    assert.deepEqual(await active(), before);
    await end(first.id);
    await end(second.id);
    const recovered = await arrive(campaignId);
    assert.equal(recovered.admitted, true);
    await end(recovered.id);
    return { retained: before, rejection: rejected.id, recovered: recovered.id };
  });
  assert.deepEqual(await active(), { calls: 0, offers: 0, slots: 0, legs: 0, claims: 0, operations: 0 });
  assert.equal(report.poolError, undefined);
} catch (error) {
  failure = error;
} finally {
  clearInterval(resourceTimer);
  const metricNames = [
    "outbound_dialer_admission_lock_wait_seconds",
    "outbound_dialer_admission_conflicts_total",
    "outbound_dialer_capacity_rejections_total"
  ];
  report.metrics = await Promise.all(metricNames.map((name) => metricsRegistry.getSingleMetric(name).get()));
  report.samples = samples;
  report.latency = Object.fromEntries(
    ["admission", "offerSnapshot", "accept"].map((name) => [
      name,
      summarizeLatency(samples[name] ?? [], latencyLimits[name])
    ])
  );
  const cleanupTasks = { api: app.close() };
  if (fixture) {
    cleanupTasks.database = (async () => {
      try {
        report.final = await active();
      } finally {
        await fixture.cleanup();
      }
    })();
  }
  const cleanup = await Promise.allSettled(Object.values(cleanupTasks));
  report.cleanup = Object.fromEntries(
    Object.keys(cleanupTasks).map((key, i) => [
      key,
      cleanup[i].status === "fulfilled" ? "passed" : String(cleanup[i].reason)
    ])
  );
  const budgetFailure = [
    ...Object.values(report.latency),
    ...report.scenarios.flatMap(({ latency }) => Object.values(latency ?? {}))
  ].some(({ status }) => status !== "passed");
  failure ??= cleanup.find((result) => result.status === "rejected")?.reason;
  if (!failure && budgetFailure) failure = new Error("Incomplete or over-budget latency measurements");
  report.status = failure ? "failed" : "passed";
  if (failure) report.error = failure.stack;
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(`I03 control report: ${join(directory, "i03-control.json")}`);
}
if (failure) throw failure;
