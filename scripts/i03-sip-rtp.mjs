import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { loadDesk, loadMutation } from "../tests/fixtures/inbound/load-desk.mjs";
import { dispatchInboundOffers } from "../apps/api/dist-test/inbound-dispatcher.js";
import { invite } from "./a02-ingress-probe.mjs";
import { assertTone, decodeUlaw, endpoint, until } from "./a05-media.mjs";
import { budgets } from "./a06-budgets.mjs";
import {
  loadMeasurements,
  loadProfiles,
  seededOrder,
  summarizeLatency
} from "./inbound-load-measurements.mjs";

export async function runSipRtpLoad({ app, f, config, command, startCall, recover, clean, runtime, pass }) {
  const desks = [];
  const callers = [];
  let mainCaller;
  let mainEnded = false;
  const { agents, burst, seed } = loadProfiles.smoke;
  const { samples, measure } = loadMeasurements();
  const counts = (sql, args) => f.pool.query(sql, args).then(({ rows }) => rows[0]);
  try {
    for (let i = 0; i < agents; i++) {
      desks.push(
        await loadDesk(f.pool, config, f.campaignId, `i03-sip-${i}`, (username) =>
          endpoint({ username, password: "fixture", source: "127.0.0.3", frequency: 660 })
        )
      );
    }
    const caller = await startCall();
    mainCaller = caller;
    callers.push(caller.result);
    await recover();
    const offers = await Promise.allSettled(desks.map((desk) => dispatchInboundOffers(f.pool, desk.id)));
    assert.ok(
      offers.every((result) => result.status === "fulfilled" && result.value?.callId === caller.row.uuid),
      JSON.stringify(offers)
    );
    assert.deepEqual(
      await counts(
        `select
      (select count(*)::int from call_legs where call_id=$1 and type='agent') as legs,
      (select count(*)::int from agent_call_slots where call_id=$1) as slots`,
        [caller.row.uuid]
      ),
      { legs: 0, slots: 0 }
    );
    const attempts = seededOrder(
      desks.map((desk, i) => ({
        desk,
        method: "POST",
        url: `/agent/call-offers/${offers[i].value.id}/accept`,
        headers: desk.headers,
        payload: loadMutation(desk)
      })),
      seed
    );
    const responses = await Promise.all(
      attempts.map(async ({ desk, ...request }) => {
        const response = await app.inject(request);
        return { desk, request, response, respondedAt: performance.now() };
      })
    );
    const [winner, ...extraWinners] = responses.filter(({ response }) => response.statusCode === 200);
    assert.ok(winner);
    assert.equal(extraWinners.length, 0);
    assert.ok(
      responses.every(
        ({ response }) =>
          response.statusCode === 200 ||
          (response.statusCode === 409 && response.json().code === "offer_closed")
      )
    );
    const operationId = winner.response.json().operationId;
    assert.equal((await app.inject(winner.request)).json().operationId, operationId);
    const tones = await measure(
      "udpConnection",
      async () => {
        await runtime.wakeExecutor(operationId);
        await until(
          async () =>
            (await counts("select state from calls where id=$1", [caller.row.uuid])).state ===
            "agent_connected",
          "I03 durable bridge"
        );
        await until(
          () =>
            winner.desk.phone.received.length >= 2400 &&
            caller.control
              .packets()
              .slice(-15)
              .flatMap((packet) => packet.payload).length >= 2400,
          "I03 both RTP legs"
        );
        const agentTone = assertTone(winner.desk.phone.received.slice(-2400), 880);
        const callerTone = await until(() => {
          const audio = caller.control
            .packets()
            .slice(-15)
            .flatMap((packet) => packet.payload.map(decodeUlaw));
          try {
            return assertTone(audio, 660);
          } catch {
            return false;
          }
        }, "I03 caller receives agent tone");
        return { towardAgent: agentTone, towardCaller: callerTone };
      },
      winner.respondedAt
    );
    assert.equal(
      desks.reduce((total, desk) => total + new Set(desk.phone.invites.map(({ id }) => id)).size, 0),
      1
    );
    assert.ok(desks.every((desk) => desk.phone.errors.length === 0));
    const udpConnection = summarizeLatency(samples.udpConnection, [
      budgets.connectionP95Ms,
      budgets.connectionP99Ms
    ]);
    assert.equal(udpConnection.status, "passed", JSON.stringify(udpConnection));
    await pass("I03.1 routed UDP SIP and decoded two-way RTP after twenty Desk claimants", {
      seed,
      agents,
      caller: caller.row.uuid,
      operationId,
      tones,
      udpConnection,
      samples
    });

    // Keep the established conversation active while the narrow lab ingress
    // guard sees a simultaneous wave. Caller peers terminate within the fixture deadline.
    const receivedBefore = winner.desk.phone.received.length;
    const overload = Array.from({ length: burst }, (_, index) =>
      invite({ port: 5090, caller: `+1202555${String(100 + index).padStart(4, "0")}`, timeoutMs: 23000 })
    );
    callers.push(...overload);
    let finished = false;
    const finishedOverload = Promise.allSettled(overload).then((results) => {
      finished = true;
      return results;
    });
    while (!finished) {
      await recover();
      await delay(25);
    }
    const results = await finishedOverload;
    assert.ok(
      results.every((result) => result.status === "fulfilled"),
      JSON.stringify(results.map(({ reason }) => reason?.message))
    );
    const sipFinals = {};
    for (const { value } of results) {
      assert.ok([200, 480, 486, 503].includes(value.final), `Unexpected SIP final ${value.final}`);
      if (value.final === 200) assert.ok(value.bye, "Admitted overload call did not terminate");
      sipFinals[value.final] = (sipFinals[value.final] ?? 0) + 1;
    }
    assert.ok(sipFinals[503] > 0, JSON.stringify(sipFinals));
    assert.equal(
      (await counts("select state from calls where id=$1", [caller.row.uuid])).state,
      "agent_connected"
    );
    const postBurstAudio = winner.desk.phone.received.slice(
      Math.max(receivedBefore, winner.desk.phone.received.length - 2400)
    );
    const postBurstTone = assertTone(postBurstAudio, 880);
    const terminal = performance.now();
    caller.control.hangup();
    const actual = await caller.result;
    mainEnded = true;
    assert.equal(actual.final, 200);
    assert.ok(actual.bye);
    await runtime.reconcile();
    await clean(caller.row.uuid);
    await recover();
    const cleanupMs = performance.now() - terminal;
    assert.ok(cleanupMs <= budgets.recoveryMs);
    await pass("I03.3 local twenty-INVITE overload with ongoing media", {
      burst,
      sipFinals,
      postBurstTone,
      cleanupMs,
      limits: { preAdmission: 2, trunk: 4 },
      channelsAfter: JSON.parse(await command("show channels as json")).row_count
    });
  } finally {
    if (mainCaller && !mainEnded) {
      mainCaller.control.cancel();
      mainCaller.control.hangup();
    }
    await Promise.allSettled(callers);
    for (const desk of desks) await desk.phone.close();
  }
}
