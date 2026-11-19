import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { persistenceDiagnostic } from "./esl-listener-state.js";
import { publishInboundMetrics, recordAdmissionConflict } from "./inbound-metrics.js";
import { startIngressAgent } from "./ingress-agent.js";
import { reconcileIngress } from "./inbound-ingress.js";
import type pg from "pg";
import { __testing, recordFreeSwitchEventProcessed } from "./metrics.js";

test("H05.1: allowlisted labels and structured ESL diagnostics exclude caller data, credentials and raw SIP", async () => {
  const phone = "+12025550100",
    secret = "fixture-authorization-secret",
    callId = randomUUID(),
    operationId = randomUUID(),
    jobUuid = randomUUID();
  const initialScrape = await __testing.metrics();
  assert.match(initialScrape, /^outbound_dialer_executor_pressure_total\{reason="executor_saturated"\} 0$/m);
  assert.match(initialScrape, /^outbound_dialer_capacity_rejections_total\{limit="queue"\} 0$/m);
  recordAdmissionConflict({ code: "55P03", reason: secret });
  recordAdmissionConflict({ reason: phone });
  recordFreeSwitchEventProcessed("CUSTOM");
  recordFreeSwitchEventProcessed(secret);
  publishInboundMetrics([
    { metric: "offer", label: "inbound", detail: "expired", value: "2" },
    { metric: "offer", label: callId, detail: phone, value: "2" },
    { metric: "flow", label: "forward_external", detail: secret, value: "2" },
    { metric: "transfer", label: operationId, detail: "", value: "2" },
    { metric: "capacity", label: jobUuid, detail: "", value: "2" }
  ]);
  const diagnostic = persistenceDiagnostic(
    {
      "event-name": "CUSTOM",
      "event-subclass": "outbound_dialer::inbound_forward_finished",
      variable_outbound_dialer_ingress_uuid: callId,
      "outbound-dialer-operation-id": operationId,
      "job-uuid": jobUuid,
      "caller-caller-id-number": phone,
      "sip-authorization": secret
    },
    { code: "55P03", message: `failed: ${secret} ${phone}` }
  );
  assert.deepEqual(diagnostic, {
    eventName: "CUSTOM",
    eventSubclass: "outbound_dialer::inbound_forward_finished",
    callId,
    operationId,
    jobUuid,
    code: "55P03"
  });
  assert.equal(
    JSON.stringify(
      persistenceDiagnostic(
        { "event-name": secret, "event-subclass": secret, "job-uuid": phone },
        { code: secret }
      )
    ),
    '{"eventName":"UNKNOWN"}'
  );
  const scrape = await __testing.metrics();
  for (const sensitive of [phone, secret, callId, operationId, jobUuid])
    assert.ok(!scrape.includes(sensitive));
  assert.match(scrape, /admission_conflicts_total\{reason="lock_timeout"\} 1/);
  assert.match(scrape, /admission_conflicts_total\{reason="other"\} 1/);
  assert.match(scrape, /esl_events_processed_total\{event_name="UNKNOWN"\} 1/);
  assert.match(scrape, /call_offers\{kind="inbound",outcome="expired"\} 2/);
  publishInboundMetrics([]);
  assert.match(await __testing.metrics(), /call_offers\{kind="inbound",outcome="expired"\} 0/);
});

test("H05.2: the private journal poll stays fresh while import fails, and a socket outage preserves sample age", async (t) => {
  const dir = await mkdtemp("/tmp/h05-journal-");
  const socket = join(dir, "agent.sock");
  const agent = await startIngressAgent(
    socket,
    async () => {
      throw new Error("fixture SIP auth secret");
    },
    1,
    0
  );
  let running = true;
  try {
    const nowUs = Date.now() * 1000;
    const uuid = randomUUID();
    const originalClock = t.mock.method(Date, "now", () => (nowUs - 120_000_000) / 1000);
    try {
      agent.journal.capture({
        uuid,
        arrivedUs: nowUs - 120_000_000,
        did: "+12025550100",
        callingNumber: "+12025550101",
        routeRevision: "1",
        numberId: randomUUID(),
        queueId: randomUUID(),
        queueRevision: "1",
        campaignId: randomUUID(),
        timeoutMs: 60000,
        routeData: "e30"
      });
    } finally {
      originalClock.mock.restore();
    }
    agent.journal.acknowledge(uuid, 1);
    const terminal = agent.journal.terminal(uuid);
    const response = await fetch(`http://127.0.0.1:${agent.capturePort}/capture`, {
      method: "POST",
      body: new URLSearchParams({ uuid: randomUUID() })
    });
    assert.equal(response.status, 503);
    await response.text();
    await assert.rejects(
      reconcileIngress({} as pg.Pool, socket, async () => {
        throw new Error("unreachable");
      })
    );
    await __testing.refreshIngressJournalMetrics(socket);
    const scrape = await __testing.metrics();
    assert.match(scrape, /^outbound_dialer_ingress_journal_up 1$/m);
    assert.match(scrape, /^outbound_dialer_ingress_journal_used 1$/m);
    assert.match(scrape, /^outbound_dialer_ingress_import_failures_total 1$/m);
    assert.match(scrape, /^outbound_dialer_ingress_capture_last_failure_timestamp_seconds [1-9]/m);
    assert.match(scrape, /^outbound_dialer_ingress_import_last_success_timestamp_seconds 0$/m);
    assert.ok(terminal.terminalUs !== null);
    assert.ok(scrape.includes(`ingress_oldest_pending_timestamp_seconds ${terminal.terminalUs / 1e6}`));
    assert.ok(scrape.includes(`ingress_oldest_arrival_timestamp_seconds ${(nowUs - 120_000_000) / 1e6}`));
    assert.doesNotMatch(scrape, /1202555010[01]|fixture SIP auth secret/);
    const fresh = scrape.match(/^outbound_dialer_ingress_journal_last_success_timestamp_seconds (.+)$/m)?.[1];
    assert.ok(Number(fresh) > 0);
    await agent.close();
    running = false;
    await __testing.refreshIngressJournalMetrics(socket);
    const unavailable = await __testing.metrics();
    assert.match(unavailable, /^outbound_dialer_ingress_journal_up 0$/m);
    assert.equal(
      unavailable.match(/^outbound_dialer_ingress_journal_last_success_timestamp_seconds (.+)$/m)?.[1],
      fresh
    );
  } finally {
    if (running) await agent.close();
    await rm(dir, { recursive: true, force: true });
  }
});
