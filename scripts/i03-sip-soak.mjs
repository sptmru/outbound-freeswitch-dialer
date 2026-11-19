import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { loadDesk, loadMutation } from "../tests/fixtures/inbound/load-desk.mjs";
import { readIngressRecords, ingressRequest } from "../apps/api/dist-test/ingress-agent.js";
import { IngressJournal } from "../apps/api/dist-test/ingress-journal.js";
import { importIngressRecord } from "../apps/api/dist-test/inbound-ingress.js";
import { AdmissionDiscoveryChanged } from "../apps/api/dist-test/call-admission.js";
import {
  acknowledgeResolvedCommandReceipts,
  commandReceiptAckIntervalMs,
  recoverCommandReceipts
} from "../apps/api/dist-test/command-recovery.js";
import { dispatchInboundOffers } from "../apps/api/dist-test/inbound-dispatcher.js";
import { inboundConnectionExecutor } from "../apps/api/dist-test/inbound-connection.js";
import { CoalescedTask } from "../apps/api/dist-test/coalesced-task.js";
import { invite, openEsl } from "./a02-ingress-probe.mjs";
import { assertTone, decodeUlaw, endpoint, until } from "./a05-media.mjs";
import { budgets, resources } from "./a06-budgets.mjs";
import {
  loadMeasurements,
  offerAtRate,
  seededOrder,
  summarizeLatency
} from "./inbound-load-measurements.mjs";

const profiles = {
  check: { seconds: 24, faults: { 5: "api", 11: "worker", 17: "esl" } },
  history: { seconds: 40, faults: {} },
  normal: { seconds: 600, faults: {} },
  soak: {
    seconds: 1800,
    faults: { 5: "api", 11: "worker", 17: "esl", 420: "api", 900: "worker", 1620: "esl" }
  }
};

export async function prefillSoakHistory(f, directory, queueId, numberId) {
  // The agent is not running yet. Populate both stores with matched terminal checkpoints.
  const journal = new IngressJournal(join(directory, "ingress.sqlite"), 128);
  try {
    for (let i = 0; i < 128; i++) {
      const uuid = randomUUID();
      journal.capture({
        uuid,
        arrivedUs: Date.now() * 1000,
        did: "+12025550100",
        routeRevision: "1",
        numberId,
        queueId,
        queueRevision: "1",
        campaignId: f.campaignId,
        timeoutMs: 18000,
        callingNumber: "unknown",
        routeData: Buffer.from("{}").toString("base64url")
      });
      const row = journal.terminal(uuid);
      await importIngressRecord(f.pool, row);
      journal.acknowledge(uuid, row.sequence);
      await f.pool.query("update inbound_ingress_evidence set acknowledged_sequence=$2 where ingress_id=$1", [
        uuid,
        row.sequence
      ]);
    }
    assert.deepEqual(
      { retained: journal.status().retained, used: journal.status().used },
      { retained: 128, used: 0 }
    );
  } finally {
    journal.close();
  }
}

async function commandProxy(esl) {
  const sockets = new Set();
  let enabled = true;
  const server = net.createServer((client) => {
    if (!enabled) return client.destroy();
    const upstream = net.createConnection({ host: esl.host, port: esl.port });
    sockets.add(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.once("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.once("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    cut() {
      enabled = false;
      const count = sockets.size;
      for (const client of sockets) client.destroy();
      return count;
    },
    restore() {
      enabled = true;
    },
    async close() {
      for (const client of sockets) client.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

export async function runSipRtpSoak({
  profile,
  f,
  config,
  esl,
  directory,
  socket,
  limited,
  coordinator,
  recover,
  command,
  clean,
  recoveryTicket,
  pass
}) {
  const plan = profiles[profile];
  assert.ok(plan);
  const agentCount = 20;
  const seed = 606;
  const conversationMs = 10000;
  const maxRtpPort = 20160;
  const report = {
    status: "running",
    profile,
    seed,
    agentCount,
    conversationMs,
    plannedRate: 1,
    ...plan,
    boundary:
      "Real Fastify HTTP child, native command worker and ESL relay; real pinned FreeSWITCH UDP SIP/RTP and PostgreSQL; seeded Desk binding",
    startedAt: new Date().toISOString(),
    calls: [],
    faultsObserved: [],
    resources: [],
    ingressPasses: [],
    errors: []
  };
  const { samples, measure } = loadMeasurements();
  const out = join(directory, "i03-sip-soak.json");
  const resultsOf = () => ({
    sipAdmission: summarizeLatency(samples.sipAdmission ?? []),
    offerDispatch: summarizeLatency(samples.offerDispatch ?? [], [budgets.offerP95Ms, budgets.offerP99Ms]),
    udpConnection: summarizeLatency(samples.udpConnection ?? [], [
      budgets.connectionP95Ms,
      budgets.connectionP99Ms
    ]),
    customerHangup: summarizeLatency(samples.customerHangup ?? [])
  });
  const log = await open(join(directory, "i03-sip-workers.log"), "a");
  const save = () => writeFile(out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const children = new Set();
  const desks = [];
  const wakeErrors = [];
  const database = {
    host: join(directory, "socket"),
    database: "e02",
    user: "postgres",
    options: `-c search_path=${f.schema}`,
    connectionTimeoutMillis: 1000
  };
  const proxy = await commandProxy(esl);
  const runtime = inboundConnectionExecutor(f.pool, limited.executor, { ...esl, port: proxy.port });
  let api, worker, tick, monitor, ingressTimer, recoveryError, maintenance, ingress;
  let receiptTimer, receipts;
  const recordRecoveryError = (error) => {
    if (error instanceof AdmissionDiscoveryChanged) {
      report.recoveryDiscoveryDeferrals = (report.recoveryDiscoveryDeferrals ?? 0) + 1;
    } else recoveryError ??= error;
  };
  const waiting = new CoalescedTask(() => recover(coordinator.reconcileWaiting), recordRecoveryError);
  const connections = new CoalescedTask(recoverConnections, recordRecoveryError);
  let offers = Promise.resolve();
  const timeStart = performance.now();
  const active = () =>
    f.pool
      .query(
        `select
    (select count(*)::int from calls where ended_at is null) calls,
    (select count(*)::int from call_offers where state='pending') offers,
    (select count(*)::int from agent_call_slots where state<>'free') slots,
    (select count(*)::int from call_legs where ended_at is null) legs,
    (select count(*)::int from call_capacity_reservations where state<>'released') claims,
    (select count(*)::int from call_operations where resolved_at is null) operations,
    (select count(*)::int from call_operations where state='uncertain' and resolved_at is null) uncertain,
    (select count(*)::int from call_command_fences f where not exists (
      select 1 from call_command_receipt_acks a where a.operation_id=f.operation_id)) "nativeReceipts",
    (select count(*)::int from inbound_ingress_evidence where terminal_at is not null and acknowledged_sequence IS DISTINCT FROM evidence_sequence) "terminalJournalLag"`
      )
      .then(({ rows }) => rows[0]);
  async function start(mode) {
    const child = fork(new URL("./i03-soak-worker.mjs", import.meta.url), [], {
      env: { PATH: process.env.PATH },
      stdio: ["ignore", log.fd, log.fd, "ipc"]
    });
    children.add(child);
    child.once("exit", () => children.delete(child));
    let ready;
    child.on("message", (entry) => {
      if (entry.type === "ready") ready = entry;
      if (entry.type === "error") wakeErrors.push(entry);
    });
    child.on("error", (error) => wakeErrors.push({ error: error.message }));
    child.send({ mode, database, config, executor: limited.database, esl: { ...esl, port: proxy.port } });
    await until(
      () => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`I03 ${mode} exited before readiness`);
        return ready;
      },
      `I03 ${mode} readiness`,
      5000
    );
    return { child, ...ready };
  }
  async function stop(child, signal = "SIGKILL") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill(signal);
    await exited;
  }
  async function refreshDesk() {
    await f.pool.query(
      "update agent_desk_sessions set verified_at=clock_timestamp(),expires_at=clock_timestamp()+interval '20 seconds' where id=any($1::uuid[])",
      [desks.map((desk) => desk.sessionId)]
    );
  }
  async function recordResources() {
    const counts = await active();
    const journal = JSON.parse(await ingressRequest(socket, "/status"));
    const [rss, memory] = await Promise.all([
      Promise.all(
        [...children].map(async (child) => {
          const status = await readFile(`/proc/${child.pid}/status`, "utf8").catch(() => "");
          return { pid: child.pid, rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) };
        })
      ),
      readFile("/proc/meminfo", "utf8")
    ]);
    report.resources.push({
      elapsedMs: Math.round(performance.now() - timeStart),
      counts,
      journal,
      processMemory: { parentRssBytes: process.memoryUsage.rss(), children: rss },
      hostMemAvailableKiB: Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]),
      parentCpu: process.cpuUsage(),
      pool: { total: f.pool.totalCount, waiters: f.pool.waitingCount },
      // Allowable fixture ceiling is smaller than the physical ports reserved by the shell.
      switchChannels: JSON.parse(await command("show channels as json")).row_count
    });
    await save();
  }
  async function recoverCallReceipts(id) {
    const ticket = recoveryTicket();
    if (!ticket) return;
    try {
      return await reconcileCall(id, ticket);
    } catch (error) {
      if (!(error instanceof AdmissionDiscoveryChanged)) throw error;
      report.recoveryDiscoveryDeferrals = (report.recoveryDiscoveryDeferrals ?? 0) + 1;
    }
  }
  async function reconcileCall(id, ticket) {
    await recoverCommandReceipts(f.pool, limited.executor, id, command, ticket);
    const root = await f.pool.query(
      "select operation_id from inbound_connection_attempts where call_id=$1 and settled_at is null",
      [id]
    );
    if (root.rowCount) await runtime.wakeExecutor(root.rows[0].operation_id);
  }
  async function recoverNative() {
    const work = await f.pool.query(`select distinct o.call_id
      from call_operations o join call_execution_attempts a on a.operation_id=o.id
      where o.resolved_at is null and o.state='uncertain' and a.transport_protocol='fs-fenced-v1'
      order by o.call_id limit 16`);
    for (const { call_id: id } of work.rows) await recoverCallReceipts(id);
  }
  async function recoverConnections() {
    // Give the primary wake time to run before the other executor competes for the same call.
    const work = await f.pool.query(`select x.operation_id from inbound_connection_attempts x
      join call_operations o on o.id=x.operation_id where x.settled_at is null
      and o.created_at<=clock_timestamp()-interval '750 milliseconds'
      order by x.deadline_at,x.operation_id limit 8`);
    for (const { operation_id: id } of work.rows) await runtime.wakeExecutor(id);
  }
  async function acknowledgeReceipts() {
    const errors = await acknowledgeResolvedCommandReceipts(f.pool, limited.executor, command);
    if (errors.length) throw errors[0].error;
  }
  async function finishCall(id, control, result) {
    control.hangup();
    const wire = await result;
    assert.equal(wire.final, 200);
    assert.ok(wire.bye);
    await until(
      async () => {
        await recoverCallReceipts(id);
        const count = await f.pool.query(
          "select count(*)::int as active from call_capacity_reservations where call_id=$1 and state<>'released'",
          [id]
        );
        return count.rows[0].active === 0;
      },
      "I03 exact terminal SQL/FS convergence",
      budgets.recoveryMs
    );
    await clean(id);
    return wire;
  }
  async function requestAccept(desk, offer) {
    const payload = loadMutation(desk);
    await until(() => api, "I03 active HTTP replica", 5000);
    const response = await fetch(`${api.address}/agent/call-offers/${offer.id}/accept`, {
      method: "POST",
      headers: { ...desk.headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  }
  async function injectFault(kind) {
    const evidence = { kind, atMs: performance.now() - timeStart, before: await active() };
    report.faultsObserved.push(evidence);
    if (evidence.before.calls === 0) report.errors.push(`${kind} fault had no admitted work at injection`);
    if (kind === "api") {
      const old = api.child;
      evidence.beforePid = old.pid;
      api = undefined;
      await stop(old);
      api = await start("api");
      evidence.afterPid = api.child.pid;
    } else if (kind === "worker") {
      const old = worker.child;
      evidence.beforePid = old.pid;
      worker = undefined;
      await stop(old);
      worker = await start("native");
      evidence.afterPid = worker.child.pid;
    } else {
      const witness = await openEsl({ port: proxy.port });
      try {
        evidence.closedTransports = proxy.cut();
        assert.ok(evidence.closedTransports > 0);
        await delay(150);
      } finally {
        witness.close();
        proxy.restore();
      }
    }
    evidence.restoredAtMs = performance.now() - timeStart;
    evidence.restoredMs = evidence.restoredAtMs - evidence.atMs;
    assert.ok(evidence.restoredMs <= budgets.recoveryMs);
    await save();
  }
  async function place(i, order, due) {
    const caller = `+1202555${String(1000 + i)}`;
    const desk = order[i % order.length];
    const sample = { sequence: i, caller };
    report.calls.push(sample);
    let control, id;
    const beforeInvites = desk.phone.invites.length;
    const result = invite({
      port: 5090,
      caller,
      frequency: 880,
      maxRtpPort,
      timeoutMs: 30000,
      control: (c) => (control = c)
    });
    result.catch(() => {});
    try {
      await measure(
        "sipAdmission",
        async () => {
          const capture = await until(
            async () => (await readIngressRecords(socket)).find((row) => row.callingNumber === caller),
            "I03 exact journal capture",
            1000
          );
          sample.id = id = capture.uuid;
          await until(
            async () => {
              const q = await f.pool.query(
                `select c.state from calls c join inbound_queue_admissions a on a.call_id=c.id
             join call_operations o on o.id=a.operation_id where c.id=$1 and o.state='succeeded'`,
                [id]
              );
              return q.rows[0]?.state === "queued";
            },
            "I03 wait admission",
            2500
          );
        },
        due
      );
      const queuedAt = performance.now();
      const offerTask = offers.then(async () => {
        const offer = await dispatchInboundOffers(f.pool, desk.id);
        assert.equal(offer?.callId, id);
        return offer;
      });
      offers = offerTask.catch(() => {});
      const offer = await measure("offerDispatch", () => offerTask, queuedAt);
      const accepted = await requestAccept(desk, offer);
      sample.operation = accepted.operationId;
      const acceptedAt = performance.now();
      if (profile === "check" && i === 8) sample.directWakeWithheld = true;
      else if (worker?.child.connected) worker.child.send({ id: accepted.operationId });
      // A killed worker's committed operation stays durable. The staged runtime may
      // reconcile it independently and is still fenced by the original command ID.
      await measure(
        "udpConnection",
        async () => {
          await until(
            async () => {
              const row = (await f.pool.query("select state from calls where id=$1", [id])).rows[0];
              return row?.state === "agent_connected" && desk.phone.invites.length === beforeInvites + 1;
            },
            "I03 recipient bridge",
            4500
          );
          const audio = await until(
            () => {
              const callerSamples = control
                .packets()
                .slice(-15)
                .flatMap((p) => p.payload.map(decodeUlaw));
              if (desk.phone.received.length < 2400 || callerSamples.length < 2400) return false;
              try {
                return {
                  towardAgent: assertTone(desk.phone.received.slice(-2400), 880),
                  towardCaller: assertTone(callerSamples, 660)
                };
              } catch {
                return false;
              }
            },
            "I03 decoded two-way connected audio",
            1000
          );
          sample.firstAudio = audio;
        },
        acceptedAt
      );
      sample.connectedAtMs = performance.now() - timeStart;
      await delay(conversationMs);
      const media = await measure("customerHangup", () => finishCall(id, control, result));
      sample.towardAgent = assertTone(desk.phone.received.splice(0).slice(-2400), 880);
      sample.towardCaller = assertTone(
        media.rtp.slice(-15).flatMap((p) => p.payload.map(decodeUlaw)),
        660
      );
      assert.equal(new Set(desk.phone.invites.splice(0).map(({ id }) => id)).size, 1);
      sample.status = "passed";
    } catch (error) {
      sample.status = "failed";
      sample.error = error.message;
      if (control) {
        try {
          control.cancel();
          control.hangup();
        } catch (error) {
          if (error.code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error;
        }
      }
      const failedWire = await result.catch(() => null);
      sample.sipFinal = failedWire?.final;
      throw error;
    }
  }
  try {
    report.host = { meminfo: (await readFile("/proc/meminfo", "utf8")).split("\n").slice(0, 3) };
    await save();
    for (let i = 0; i < agentCount; i++)
      desks.push(
        await loadDesk(f.pool, config, f.campaignId, `i03-soak-${i}`, (username) =>
          endpoint({ username, password: "fixture", source: "127.0.0.3", frequency: 660, maxRtpPort })
        )
      );
    api = await start("api");
    worker = await start("native");
    await refreshDesk();
    ingressTimer = setInterval(() => {
      waiting.request();
      if (ingress) return;
      const started = performance.now();
      ingress = recover(coordinator.reconcileReceipts)
        .then((journal) => {
          report.ingressPasses.push({
            elapsedMs: started - timeStart,
            durationMs: performance.now() - started,
            retained: journal.retained,
            used: journal.used,
            unacknowledged: journal.unacknowledged
          });
        })
        .catch((error) => {
          report.ingressPassFailures ??= {};
          report.ingressPassFailures[error.message] = (report.ingressPassFailures[error.message] ?? 0) + 1;
        })
        .finally(() => {
          ingress = undefined;
        });
    }, 100);
    tick = setInterval(() => {
      if (maintenance) return;
      maintenance = Promise.allSettled([refreshDesk(), recoverNative()]).then((results) => {
        for (const result of results) if (result.status === "rejected") recoveryError ??= result.reason;
        maintenance = undefined;
      });
    }, 5000);
    receiptTimer = setInterval(() => {
      connections.request();
      if (receipts) return;
      receipts = acknowledgeReceipts()
        .catch((error) => (recoveryError ??= error))
        .finally(() => (receipts = undefined));
    }, commandReceiptAckIntervalMs);
    monitor = setInterval(() => {
      if (monitor.pending) return;
      monitor.pending = recordResources()
        .catch((error) => {
          report.errors.push(error.message);
        })
        .finally(() => {
          delete monitor.pending;
        });
    }, 10000);
    const order = seededOrder(desks, seed);
    const result = await offerAtRate({
      count: plan.seconds,
      perSecond: 1,
      work: async (i, due) => {
        if (plan.faults[i]) {
          const [fault, call] = await Promise.allSettled([injectFault(plan.faults[i]), place(i, order, due)]);
          if (fault.status === "rejected") report.errors.push(fault.reason.message);
          if (call.status === "rejected") throw call.reason;
        } else await place(i, order, due);
      }
    });
    clearInterval(ingressTimer);
    await ingress;
    waiting.stop();
    await waiting.waitForIdle();
    clearInterval(tick);
    await maintenance;
    clearInterval(receiptTimer);
    await receipts;
    connections.stop();
    await connections.waitForIdle();
    clearInterval(monitor);
    await monitor.pending;
    await recoverNative();
    await runtime.reconcile();
    await recover();
    await until(
      async () => {
        report.final = await active();
        report.finalJournal = JSON.parse(await ingressRequest(socket, "/status"));
        report.finalChannels = JSON.parse(await command("show channels as json")).row_count;
        const pending =
          Object.values(report.final).some(Boolean) ||
          report.finalJournal.used > 0 ||
          report.finalJournal.unacknowledged > 0;
        if (pending) {
          await recoverNative();
          await acknowledgeReceipts();
          await runtime.reconcile();
          await recover();
        }
        return !pending && report.finalChannels === 0;
      },
      "I03 zero post-run lifecycle residuals",
      budgets.recoveryMs
    );
    assert.equal(result.length, plan.seconds);
    if (profile === "check") {
      const withheld = report.calls.find(({ directWakeWithheld }) => directWakeWithheld);
      assert.equal(withheld?.status, "passed", "Persisted connection progresses after a lost direct wake");
    }
    assert.equal(report.faultsObserved.length, Object.keys(plan.faults).length);
    for (const fault of report.faultsObserved) {
      const next = report.calls.find(
        ({ status, connectedAtMs }) => status === "passed" && connectedAtMs >= fault.restoredAtMs
      );
      assert.ok(next, `No clean connection after ${fault.kind} recovery`);
      fault.recoveryVerifiedMs = next.connectedAtMs - fault.restoredAtMs;
      assert.ok(fault.recoveryVerifiedMs <= budgets.recoveryMs);
    }
    assert.equal(result.filter((entry) => entry.status === "rejected").length, 0);
    assert.deepEqual(report.errors, []);
    assert.equal(recoveryError, undefined);
    assert.deepEqual(wakeErrors, []);
    report.latency = resultsOf();
    assert.ok(Object.values(report.latency).every(({ status }) => status === "passed"));
    const maximum = (field) => Math.max(0, ...report.resources.map(({ counts }) => counts[field]));
    assert.ok(maximum("operations") <= resources.backlog.limit);
    report.status = "passed";
    await pass(`I03 ${profile} sustained isolated UDP SIP/RTP`, {
      calls: result.length,
      report: out,
      faults: report.faultsObserved.length,
      final: report.final
    });
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    throw error;
  } finally {
    clearInterval(ingressTimer);
    clearInterval(tick);
    clearInterval(receiptTimer);
    clearInterval(monitor);
    waiting.stop();
    connections.stop();
    await ingress;
    await maintenance;
    await receipts;
    await waiting.waitForIdle();
    await connections.waitForIdle();
    await monitor?.pending;
    report.wakeErrors = wakeErrors;
    report.latency ??= resultsOf();
    report.samples = samples;
    report.finishedAt = new Date().toISOString();
    if (!report.final) report.final = await active().catch(() => null);
    await save();
    await Promise.all([...children].map((child) => stop(child)));
    await proxy.close();
    for (const desk of desks) desk.phone.close();
    await log.close();
  }
}
