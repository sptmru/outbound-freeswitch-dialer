import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { createTransferOffer, mutateTransferOffer } from "./transfer-offers.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { registerCallOfferRoutes } from "./dashboard/call-offers.js";
import { signAuthToken } from "./auth/tokens.js";
import type { AppConfig } from "./config.js";
import { readInboundOffer, dispatchInboundOffers } from "./inbound-dispatcher.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
const httpConfig = {
  JWT_SECRET: "g01-disposable-test-signing-secret",
  JWT_EXPIRES_SECONDS: 3600,
  CONTACT_MAX_ATTEMPTS: 3,
  CONTACT_RETRY_DELAY_SECONDS: 900,
  DEFAULT_PHONE_COUNTRY_CODE: "US",
  PUBLIC_APP_URL: "https://desk.example.test",
  corsOrigins: [],
  FREESWITCH_ESL_ENABLED: true
} as unknown as AppConfig;
async function fixture() {
  const schema = `g01_${randomUUID().replaceAll("-", "")}`,
    admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const config = { ...databaseConfig(testDatabaseUrl(), schema), max: 8 };
  const pool = new pg.Pool(config);
  await runMigrations(pool);
  await pool.query(
    "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
  );
  const campaign = (
    await pool.query(
      "insert into campaigns(name,status,manual_dialing_enabled,auto_advance_to_next_lead_enabled) values('G01','active',true,true) returning id"
    )
  ).rows[0].id;
  const otherCampaign = (
    await pool.query(
      "insert into campaigns(name,status,manual_dialing_enabled,auto_advance_to_next_lead_enabled) values('Other','active',true,true) returning id"
    )
  ).rows[0].id;
  const queue = (
    await pool.query("insert into inbound_queues(campaign_id,name) values($1,'G01') returning id", [campaign])
  ).rows[0].id;
  async function agent(campaignId = campaign) {
    const user = (
      await pool.query(
        "insert into users(email,name,role,password_hash) values($1,'G01','agent','fixture') returning *",
        [`${randomUUID()}@example.test`]
      )
    ).rows[0];
    const id = (
      await pool.query(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','G01',true) returning id",
        [user.id, randomUUID()]
      )
    ).rows[0].id;
    const d = (
      await pool.query(
        "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,verified_generation,verified_at,actor_auth_version) values($1,$2,1,$3,clock_timestamp()+interval '1 hour',true,'sip:fixture@127.0.0.1',1,clock_timestamp(),1) returning id",
        [id, campaignId, randomUUID()]
      )
    ).rows[0];
    await pool.query(
      "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
      [id]
    );
    return {
      id,
      user,
      session: d.id,
      campaignId,
      actor: { userId: user.id, agentId: id, authVersion: 1 },
      headers: {
        authorization: `Bearer ${signAuthToken(httpConfig, { sub: user.id, email: user.email, role: "agent", ver: 1 })}`
      }
    };
  }
  const source = await agent(),
    target = await agent(otherCampaign),
    outsider = await agent();
  async function call(direction: "inbound" | "outbound" = "inbound") {
    const c = (
      await pool.query(
        `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,agent_id,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
      values($1,'+14155550100','+14155550100',$2,$3,$4,$5,$7,$5,$6,clock_timestamp(),clock_timestamp()+interval '1 hour') returning id`,
        [
          campaign,
          direction,
          direction === "inbound" ? "agent_connected" : "bridged",
          source.id,
          direction === "inbound" ? "+12025550100" : null,
          direction === "inbound" ? queue : null,
          direction === "inbound" ? "+14155550100" : "+12025550100"
        ]
      )
    ).rows[0];
    const p = (
      await pool.query(
        "insert into call_participants(call_id,role,agent_id,joined_at,connected_at) values($1,'agent',$2,clock_timestamp(),clock_timestamp()) returning id",
        [c.id, source.id]
      )
    ).rows[0];
    await pool.query(
      "insert into call_legs(call_id,type,participant_id,freeswitch_uuid,state) values($1,'agent',$2,$3,'answered'),($1,'customer',null,$4,'answered')",
      [c.id, p.id, randomUUID(), randomUUID()]
    );
    await pool.query(
      "update agent_call_slots set state='reserved',reservation_id=$2,call_id=$3,participant_id=$4 where agent_id=$1",
      [source.id, randomUUID(), c.id, p.id]
    );
    await pool.query("update agent_call_slots set state='active' where agent_id=$1", [source.id]);
    return c.id as string;
  }
  const wakes: string[] = [];
  const app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: "Validation failed" });
    throw error;
  });
  registerDashboardRoutes(app, httpConfig, pool, undefined, {
    async wakeExecutor(id) {
      wakes.push(id);
    }
  });
  const offerApp = Fastify();
  await offerApp.register(cookie);
  registerCallOfferRoutes(
    offerApp,
    httpConfig,
    pool,
    {
      async wakeExecutor(id) {
        wakes.push(id);
      }
    },
    {
      async wakeExecutor(id) {
        wakes.push(id);
      }
    }
  );
  const children: ReturnType<typeof fork>[] = [];
  async function cleanup() {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) {
        const exit = once(c, "exit");
        c.kill("SIGKILL");
        await exit;
      }
    await app.close();
    await offerApp.close();
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
  const sourceState = async (callId: string) =>
    (
      await pool.query(
        `select to_jsonb(c) call,to_jsonb(s) slot,to_jsonb(p) participant,to_jsonb(l) leg
    from calls c join agent_call_slots s on s.agent_id=c.agent_id join call_participants p on p.id=s.participant_id join call_legs l on l.participant_id=p.id where c.id=$1`,
        [callId]
      )
    ).rows[0];
  async function transfer(callId: string) {
    return createTransferOffer(pool, source.actor, callId, {
      ...intent(source),
      recipientAgentId: target.id
    });
  }
  function worker(input: object) {
    const child = fork(
      new URL("../../../tests/fixtures/inbound/transfer-worker.mjs", import.meta.url),
      [JSON.stringify({ config, ...input })],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] }
    );
    children.push(child);
    const messages: any[] = [];
    let output = "",
      wake: (() => void) | undefined,
      ended = false;
    child.stderr!.on("data", (b) => (output += b));
    child.on("message", (m) => {
      messages.push(m);
      wake?.();
    });
    const exit = once(child, "exit").then(([code]) => {
      ended = true;
      wake?.();
      assert.equal(code, 0, output);
    });
    return {
      send: (type: string, extra = {}) => child.send({ type, ...extra }),
      exit,
      async wait(type: string) {
        const deadline = Date.now() + 10000;
        while (true) {
          const i = messages.findIndex((m) => m.type === type);
          if (i >= 0) return messages.splice(i, 1)[0];
          assert.ok(!ended, output);
          assert.ok(Date.now() < deadline, `${type}: ${output} ${JSON.stringify(messages)}`);
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 30);
            wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
        }
      }
    };
  }
  async function report(name: string, data: unknown) {
    if (process.env.INBOUND_TEST_ARTIFACTS)
      await writeFile(
        `${process.env.INBOUND_TEST_ARTIFACTS}/g01-${name}.json`,
        JSON.stringify(data, null, 2)
      );
  }
  return {
    pool,
    config,
    campaign,
    otherCampaign,
    queue,
    source,
    target,
    outsider,
    agent,
    call,
    app,
    offerApp,
    wakes,
    cleanup,
    sourceState,
    transfer,
    worker,
    report
  };
}
const intent = (a: { session: string }) => ({
  deskSessionId: a.session,
  expectedRevision: "1",
  bindingGeneration: "1",
  idempotencyKey: randomUUID()
});

test(
  "G01.1 DB/API both directions, cross-campaign hint/revalidation, auth, replay and one unfinished transfer",
  options,
  async () => {
    for (const direction of ["inbound", "outbound"] as const) {
      const f = await fixture();
      try {
        const callId = await f.call(direction),
          before = await f.sourceState(callId),
          input = { ...intent(f.source), recipientAgentId: f.target.id };
        const targets = await f.app.inject({
          method: "GET",
          url: `/agent/calls/${callId}/transfer-targets?deskSessionId=${f.source.session}`,
          headers: f.source.headers
        });
        assert.equal(targets.statusCode, 200, targets.body);
        assert.equal(targets.json().items.find((r: any) => r.agentId === f.target.id).available, true);
        assert.equal(
          (
            await f.app.inject({
              method: "GET",
              url: `/agent/calls/${callId}/transfer-targets?deskSessionId=${f.source.session}`
            })
          ).statusCode,
          401
        );
        await assert.rejects(
          createTransferOffer(f.pool, f.outsider.actor, callId, {
            ...intent(f.outsider),
            recipientAgentId: f.target.id
          }),
          /not_owner/
        );
        await assert.rejects(
          createTransferOffer(f.pool, f.source.actor, callId, { ...input, recipientAgentId: f.source.id }),
          /not_owner/
        );
        await f.pool.query("update agents set availability_status='paused' where id=$1", [f.target.id]);
        await assert.rejects(createTransferOffer(f.pool, f.source.actor, callId, input), /paused/);
        const unavailable = await f.app.inject({
          method: "POST",
          url: `/agent/calls/${callId}/transfers`,
          headers: f.source.headers,
          payload: input
        });
        assert.equal(unavailable.statusCode, 409, unavailable.body);
        assert.equal(unavailable.json().code, "coordination_unavailable");
        assert.equal(unavailable.json().message, "paused");
        await f.pool.query("update agents set availability_status='available' where id=$1", [f.target.id]);
        const response = await f.app.inject({
          method: "POST" as const,
          url: `/agent/calls/${callId}/transfers`,
          headers: f.source.headers,
          payload: input
        });
        assert.equal(response.statusCode, 200, response.body);
        const t = response.json();
        assert.deepEqual(await createTransferOffer(f.pool, f.source.actor, callId, input), t);
        await assert.rejects(
          createTransferOffer(f.pool, f.source.actor, callId, { ...input, recipientAgentId: f.outsider.id }),
          /idempotency_conflict/
        );
        await assert.rejects(f.transfer(callId), /transfer_in_progress/);
        assert.deepEqual(await f.sourceState(callId), before);
        assert.equal(
          (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.target.id])).rows[0]
            .state,
          "free"
        );
        assert.equal((await f.pool.query("select count(*)::int n from call_operations")).rows[0].n, 0);
        assert.equal(
          (await readInboundOffer(f.pool, f.target.actor, f.target.session)).offer?.kind,
          "transfer"
        );
        assert.equal(
          (await readInboundOffer(f.pool, f.target.actor, f.target.session)).offer?.callingNumber,
          "+14155550100"
        );
        assert.equal((await dispatchInboundOffers(f.pool, f.target.id))?.id, t.offerId);
        await f.report(`create-${direction}`, { transfer: t, source: before, wakes: f.wakes });
      } finally {
        await f.cleanup();
      }
    }
  }
);

test("G01.1 DB existing inbound offer/occupied or stale recipient cannot be replaced", options, async () => {
  const f = await fixture();
  try {
    const callId = await f.call();
    const queued = (
      await f.pool.query(
        `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
      values($1,'+12025550122','+12025550122','inbound','queued','+12025550100','+14155550100','+12025550100',$2,clock_timestamp(),clock_timestamp()+interval '1 hour') returning id`,
        [f.campaign, f.queue]
      )
    ).rows[0].id;
    const offer = (
      await f.pool.query(
        "insert into call_offers(call_id,kind,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at) values($1,'inbound',$2,1,$3,1,1,clock_timestamp()+interval '1 hour') returning *",
        [queued, f.target.id, f.target.session]
      )
    ).rows[0];
    await assert.rejects(f.transfer(callId), /incoming_pending/);
    assert.deepEqual(
      (await f.pool.query("select * from call_offers where id=$1", [offer.id])).rows[0],
      offer
    );
    await f.pool.query(
      "update call_offers set state='canceled',reason='fixture',closed_at=clock_timestamp() where id=$1",
      [offer.id]
    );
    await f.pool.query(
      "update agent_desk_sessions set verified_at=clock_timestamp()-interval '1 minute' where id=$1",
      [f.target.session]
    );
    await assert.rejects(f.transfer(callId), /endpoint_unavailable/);
    await f.pool.query("update agent_desk_sessions set verified_at=clock_timestamp() where id=$1", [
      f.target.session
    ]);
    await f.pool.query(
      "update agent_call_slots set state='reserved',reservation_id=$2,call_id=$3 where agent_id=$1",
      [f.target.id, randomUUID(), queued]
    );
    await assert.rejects(f.transfer(callId), /slot_occupied/);
  } finally {
    await f.cleanup();
  }
});

test(
  "G01.2 DB/API decline/cancel/expiry/terminal retain exact source and never reoffer; durable replay",
  options,
  async () => {
    for (const mode of ["ignore", "cancel", "expiry", "terminal"] as const) {
      const f = await fixture();
      try {
        const callId = await f.call(),
          before = await f.sourceState(callId);
        let t = await f.transfer(callId);
        const input = intent(mode === "cancel" ? f.source : f.target);
        if (mode === "expiry") {
          // A separate due-history fixture uses PostgreSQL time; production deadlines are immutable.
          await mutateTransferOffer(
            f.pool,
            f.source.actor,
            t.transfer!.id,
            intent(f.source),
            "cancel",
            callId
          );
          const row = (
            await f.pool.query(
              `insert into call_transfers(call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,created_at,deadline_at)
        values($1,2,$2,$3,$4,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute') returning *`,
              [callId, f.source.id, before.participant.id, f.target.id]
            )
          ).rows[0];
          const offer = (
            await f.pool.query(
              `insert into call_offers(call_id,kind,transfer_id,agent_id,attempt,desk_session_id,desk_revision,binding_generation,created_at,deadline_at)
        values($1,'transfer',$2,$3,2,$4,1,1,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute') returning id`,
              [callId, row.id, f.target.id, f.target.session]
            )
          ).rows[0];
          t = {
            status: "applied",
            revision: "1",
            transfer: { ...t.transfer!, id: row.id },
            offerId: offer.id
          };
        }
        if (mode === "terminal")
          await f.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
            callId
          ]);
        const url =
          mode === "cancel"
            ? `/agent/calls/${callId}/transfers/${t.transfer!.id}`
            : `/agent/call-offers/${t.offerId}/ignore`;
        const request = {
          method: mode === "cancel" ? ("DELETE" as const) : ("POST" as const),
          url,
          headers: mode === "cancel" ? f.source.headers : f.target.headers,
          payload: input
        };
        const response = await f.app.inject(request);
        assert.equal(response.statusCode, ["expiry", "terminal"].includes(mode) ? 409 : 200, response.body);
        const row = (await f.pool.query("select * from call_transfers where id=$1", [t.transfer!.id]))
          .rows[0];
        assert.equal(
          row.reason,
          mode === "expiry"
            ? "deadline_elapsed"
            : mode === "terminal"
              ? "call_closed"
              : mode === "ignore"
                ? "user_declined"
                : "source_canceled"
        );
        const offer = (await f.pool.query("select * from call_offers where id=$1", [t.offerId])).rows[0];
        assert.equal(offer.state, row.state);
        if (mode !== "terminal") assert.deepEqual(await f.sourceState(callId), before);
        assert.equal((await readInboundOffer(f.pool, f.target.actor, f.target.session)).offer, null);
        assert.equal(await dispatchInboundOffers(f.pool, f.target.id), null);
        if (!["expiry", "terminal"].includes(mode))
          assert.deepEqual((await f.app.inject(request)).json(), response.json());
        assert.equal((await f.pool.query("select count(*)::int n from call_operations")).rows[0].n, 0);
        assert.equal((await f.pool.query("select count(*)::int n from call_offer_exclusions")).rows[0].n, 0);
        await f.report(mode, { transfer: row, offer, wakes: f.wakes });
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "G01.3 DB/API accepted reservation/replay/cancel fence, capacity rollback and absent G02 executor",
  options,
  async () => {
    const f = await fixture();
    try {
      const callId = await f.call(),
        before = await f.sourceState(callId),
        t = await f.transfer(callId),
        input = intent(f.target);
      const url = `/agent/call-offers/${t.offerId}/accept`;
      assert.equal(
        (await f.app.inject({ method: "POST" as const, url, headers: f.target.headers, payload: input }))
          .statusCode,
        409
      );
      await assert.rejects(
        mutateTransferOffer(f.pool, f.target.actor, t.offerId!, input, "accept", undefined, async () => {
          throw new Error("injected_rollback");
        }),
        /injected_rollback/
      );
      assert.equal(
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.target.id])).rows[0]
          .state,
        "free"
      );
      const response = await f.offerApp.inject({
        method: "POST" as const,
        url,
        headers: f.target.headers,
        payload: input
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(
        (
          await f.offerApp.inject({ method: "POST" as const, url, headers: f.target.headers, payload: input })
        ).json(),
        response.json()
      );
      assert.deepEqual(
        await mutateTransferOffer(
          f.pool,
          f.target.actor,
          t.offerId!,
          { ...input, idempotencyKey: randomUUID() },
          "accept"
        ),
        response.json()
      );
      assert.equal(
        (
          await f.app.inject({
            method: "DELETE",
            url: `/agent/calls/${callId}/transfers/${t.transfer!.id}`,
            headers: f.source.headers,
            payload: intent(f.source)
          })
        ).statusCode,
        409
      );
      assert.deepEqual(await f.sourceState(callId), before);
      assert.equal((await f.pool.query("select count(*)::int n from call_operations")).rows[0].n, 1);
      assert.equal(
        (await f.pool.query("select count(*)::int n from call_capacity_reservations where state<>'released'"))
          .rows[0].n,
        2
      );
      for (const route of ["/agent/manual-dial/start", "/agent/call-next"]) {
        const r = await f.app.inject({
          method: "POST" as const,
          url: route,
          headers: f.target.headers,
          payload: {
            campaignId: f.otherCampaign,
            ...(route.includes("manual") ? { phoneNumber: "+14155550123" } : {}),
            intent: { ...intent(f.target), startReason: "manual" }
          }
        });
        assert.equal(r.statusCode, 409, r.body);
      }
      await f.report("accepted", {
        response: response.json(),
        source: before,
        operations: (await f.pool.query("select * from call_operations")).rows
      });
    } finally {
      await f.cleanup();
    }
  }
);

const manualRoutes = ["/agent/manual-dial/start", "/agent/call-next", "/agent/leads/:contactId/call"];
test(
  "G01.3/G01.4 real HTTP manual routes versus product transfer acceptance across workers: both commit orders and rollback",
  { ...options, timeout: 120000 },
  async () => {
    for (const route of manualRoutes)
      for (const first of ["transfer", "manual"] as const)
        for (const rollback of [false, true]) {
          const f = await fixture();
          try {
            const callId = await f.call(),
              before = await f.sourceState(callId),
              t = await f.transfer(callId);
            const contact = (
              await f.pool.query(
                "insert into contacts(campaign_id,phone_number,normalized_phone_number) values($1,'+14155550123','+14155550123') returning id",
                [f.otherCampaign]
              )
            ).rows[0].id;
            const http = {
              method: "POST" as const,
              url: route.replace(":contactId", contact),
              headers: f.target.headers,
              payload: {
                ...(route.includes(":contactId") ? {} : { campaignId: f.otherCampaign }),
                ...(route.includes("manual") ? { phoneNumber: "+14155550123" } : {}),
                intent: { ...intent(f.target), startReason: "manual" }
              }
            };
            const requests = {
              transfer: {
                mode: "transfer",
                actor: f.target.actor,
                offerId: t.offerId,
                intent: intent(f.target)
              },
              manual: { mode: "manual", actor: f.target.actor, httpConfig, http }
            };
            const winner = f.worker({ ...requests[first], hold: true }),
              loser = f.worker(requests[first === "transfer" ? "manual" : "transfer"]);
            const [w, l] = await Promise.all([winner.wait("ready"), loser.wait("ready")]);
            assert.notEqual(w.backend, l.backend);
            winner.send("start");
            await winner.wait("claimed");
            loser.send("start");
            await assertBlocked(f.pool, l.backend, w.backend);
            winner.send("finish", { rollback });
            const [wr, lr] = await Promise.all([winner.wait("result"), loser.wait("result")]);
            await Promise.all([winner.exit, loser.exit]);
            if (rollback)
              assert.match(
                wr.error ?? wr.result?.body?.message ?? "",
                /injected_rollback|Internal Server Error/
              );
            const actual = rollback ? (first === "transfer" ? "manual" : "transfer") : first;
            const transfer = (
              await f.pool.query("select * from call_transfers where id=$1", [t.transfer!.id])
            ).rows[0];
            assert.equal(
              transfer.state,
              actual === "transfer" ? "connecting" : "declined",
              JSON.stringify({ wr, lr })
            );
            const slot = (
              await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.target.id])
            ).rows[0];
            assert.equal(slot.call_id === callId, actual === "transfer");
            assert.deepEqual(await f.sourceState(callId), before);
            const counts = (
              await f.pool.query(
                `select (select count(*)::int from call_operations) operations,(select count(*)::int from call_execution_attempts) sends,
        (select count(*)::int from call_participants where agent_id=$1) participants,(select count(*)::int from contacts where attempt_count>0) attempts`,
                [f.target.id]
              )
            ).rows[0];
            assert.equal(counts.operations, 1);
            assert.equal(counts.sends, 0);
            assert.equal(
              counts.attempts,
              actual === "manual" && route !== "/agent/manual-dial/start" ? 1 : 0
            );
            assert.equal(counts.participants, 1);
            if (!rollback)
              assert.ok(
                first === "transfer"
                  ? lr.result?.statusCode === 409
                  : Boolean(lr.error || lr.result?.conflict),
                JSON.stringify({ wr, lr })
              );
            if (actual === "manual") assert.equal((await f.app.inject(http)).statusCode, 200);
            await f.report(`race-${manualRoutes.indexOf(route)}-${first}-${rollback}`, {
              actual,
              wr,
              lr,
              slot,
              counts,
              transfer,
              source: before
            });
          } finally {
            await f.cleanup();
          }
        }
  }
);

test(
  "G01.3 DB/API failed manual routes preserve live transfer and source; source already closed does not block manual",
  options,
  async () => {
    for (const route of manualRoutes) {
      const f = await fixture();
      try {
        const callId = await f.call(),
          before = await f.sourceState(callId),
          t = await f.transfer(callId);
        const contact = (
          await f.pool.query(
            "insert into contacts(campaign_id,phone_number,normalized_phone_number,status) values($1,'+14155550123','+14155550123','suppressed') returning id",
            [f.otherCampaign]
          )
        ).rows[0].id;
        const http = {
          method: "POST" as const,
          url: route.replace(":contactId", contact),
          headers: f.target.headers,
          payload: {
            ...(route.includes(":contactId") ? {} : { campaignId: f.otherCampaign }),
            ...(route.includes("manual") ? { phoneNumber: "123" } : {}),
            intent: { ...intent(f.target), startReason: "manual" }
          }
        };
        const response = await f.app.inject(http);
        assert.ok([204, 400, 409, 422].includes(response.statusCode), response.body);
        assert.equal(
          (await f.pool.query("select state from call_transfers where id=$1", [t.transfer!.id])).rows[0]
            .state,
          "offered"
        );
        assert.deepEqual(await f.sourceState(callId), before);
        await f.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
          callId
        ]);
        await f.pool.query("update contacts set status='new' where id=$1", [contact]);
        if ("phoneNumber" in http.payload) http.payload.phoneNumber = "+14155550123";
        const started = await f.app.inject(http);
        assert.equal(started.statusCode, 200, started.body);
        const row = (await f.pool.query("select * from call_transfers where id=$1", [t.transfer!.id]))
          .rows[0];
        assert.equal(row.reason, "call_closed");
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "G01.4 product transfer acceptance versus automatic HTTP start in both orders preserves priority and one slot",
  options,
  async () => {
    for (const first of ["transfer", "automatic"] as const) {
      const f = await fixture();
      try {
        const callId = await f.call(),
          before = await f.sourceState(callId),
          t = await f.transfer(callId);
        const contact = (
          await f.pool.query(
            "insert into contacts(campaign_id,phone_number,normalized_phone_number) values($1,'+14155550122','+14155550122') returning id",
            [f.otherCampaign]
          )
        ).rows[0].id;
        const completed = (
          await f.pool.query(
            `insert into calls(campaign_id,destination_number,normalized_destination_number,agent_id,state,ended_at,agent_released_at,terminal_source,contact_id)
      values($1,'+14155550122','+14155550122',$2,'completed',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute','channel_hangup_complete',$3) returning id`,
            [f.otherCampaign, f.target.id, contact]
          )
        ).rows[0].id;
        const http = {
          method: "POST" as const,
          url: "/agent/call-next",
          headers: f.target.headers,
          payload: {
            campaignId: f.otherCampaign,
            intent: { ...intent(f.target), startReason: "automatic", sourceCallId: completed }
          }
        };
        const requests = {
          transfer: { mode: "transfer", actor: f.target.actor, offerId: t.offerId, intent: intent(f.target) },
          automatic: { mode: "automatic", actor: f.target.actor, httpConfig, http }
        };
        const winner = f.worker({ ...requests[first], hold: true }),
          loser = f.worker(requests[first === "transfer" ? "automatic" : "transfer"]);
        const [w, l] = await Promise.all([winner.wait("ready"), loser.wait("ready")]);
        winner.send("start");
        await winner.wait("claimed");
        loser.send("start");
        await assertBlocked(f.pool, l.backend, w.backend);
        winner.send("finish");
        const results = await Promise.all([winner.wait("result"), loser.wait("result")]);
        await Promise.all([winner.exit, loser.exit]);
        assert.equal(
          (await f.pool.query("select state from call_transfers where id=$1", [t.transfer!.id])).rows[0]
            .state,
          "connecting",
          JSON.stringify(results)
        );
        assert.equal((await f.pool.query("select count(*)::int n from call_operations")).rows[0].n, 1);
        assert.equal(
          (await f.pool.query("select count(*)::int n from call_execution_attempts")).rows[0].n,
          0
        );
        assert.deepEqual(await f.sourceState(callId), before);
        await f.report(`automatic-${first}`, results);
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "G01.4 stale inbound acceptance versus transfer acceptance across workers in both orders cannot start another conversation",
  options,
  async () => {
    for (const first of ["transfer", "inbound"] as const) {
      const f = await fixture();
      try {
        await f.pool.query("update agent_desk_sessions set campaign_id=$2 where id=$1", [
          f.target.session,
          f.campaign
        ]);
        const callId = await f.call(),
          before = await f.sourceState(callId);
        const queued = (
          await f.pool.query(
            `insert into calls(campaign_id,destination_number,normalized_destination_number,direction,state,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at)
      values($1,'+12025550122','+12025550122','inbound','queued','+12025550100','+14155550100','+12025550100',$2,clock_timestamp(),clock_timestamp()+interval '1 hour') returning id`,
            [f.campaign, f.queue]
          )
        ).rows[0].id;
        const inbound = (
          await f.pool.query(
            `insert into call_offers(call_id,kind,agent_id,attempt,desk_session_id,desk_revision,binding_generation,deadline_at,state,reason,closed_at)
      values($1,'inbound',$2,1,$3,1,1,clock_timestamp()+interval '1 hour','canceled','winner_accepted',clock_timestamp()) returning id`,
            [queued, f.target.id, f.target.session]
          )
        ).rows[0].id;
        const t = await f.transfer(callId);
        const requests = {
          transfer: { mode: "transfer", actor: f.target.actor, offerId: t.offerId, intent: intent(f.target) },
          inbound: { mode: "inbound", actor: f.target.actor, offerId: inbound, intent: intent(f.target) }
        };
        const winner = f.worker({ ...requests[first], hold: true }),
          loser = f.worker(requests[first === "transfer" ? "inbound" : "transfer"]);
        const [w, l] = await Promise.all([winner.wait("ready"), loser.wait("ready")]);
        winner.send("start");
        await winner.wait("claimed");
        loser.send("start");
        await assertBlocked(f.pool, l.backend, w.backend);
        winner.send("finish");
        const results = await Promise.all([winner.wait("result"), loser.wait("result")]);
        await Promise.all([winner.exit, loser.exit]);
        assert.equal(
          (await f.pool.query("select state from call_transfers where id=$1", [t.transfer!.id])).rows[0]
            .state,
          "connecting",
          JSON.stringify(results)
        );
        assert.equal(
          (await f.pool.query("select count(*)::int n from call_operations where command_kind='originate'"))
            .rows[0].n,
          0
        );
        assert.equal(
          (await f.pool.query("select count(*)::int n from call_execution_attempts")).rows[0].n,
          0
        );
        assert.equal(
          (await f.pool.query("select call_id from agent_call_slots where agent_id=$1", [f.target.id]))
            .rows[0].call_id,
          callId
        );
        assert.deepEqual(await f.sourceState(callId), before);
        await f.report(`inbound-${first}`, results);
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "G01.2 acceptance versus source cancel: both commit orders preserve source and accepted reservation",
  options,
  async () => {
    for (const first of ["transfer", "cancel"] as const) {
      const f = await fixture();
      try {
        const callId = await f.call(),
          before = await f.sourceState(callId),
          t = await f.transfer(callId);
        const requests = {
          transfer: { mode: "transfer", actor: f.target.actor, offerId: t.offerId, intent: intent(f.target) },
          cancel: {
            mode: "cancel",
            httpConfig,
            http: {
              method: "DELETE",
              url: `/agent/calls/${callId}/transfers/${t.transfer!.id}`,
              headers: f.source.headers,
              payload: intent(f.source)
            }
          }
        };
        const winner = f.worker({ ...requests[first], hold: true }),
          loser = f.worker(requests[first === "transfer" ? "cancel" : "transfer"]);
        const [w, l] = await Promise.all([winner.wait("ready"), loser.wait("ready")]);
        winner.send("start");
        await winner.wait("claimed");
        loser.send("start");
        await assertBlocked(f.pool, l.backend, w.backend);
        winner.send("finish");
        const results = await Promise.all([winner.wait("result"), loser.wait("result")]);
        await Promise.all([winner.exit, loser.exit]);
        assert.equal(
          (await f.pool.query("select state from call_transfers where id=$1", [t.transfer!.id])).rows[0]
            .state,
          first === "transfer" ? "connecting" : "canceled",
          JSON.stringify(results)
        );
        assert.deepEqual(await f.sourceState(callId), before);
        await f.report(`cancel-${first}`, results);
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "G01.3 capacity rejection rolls back complete recipient intent; migration replay history is immutable",
  options,
  async () => {
    const f = await fixture();
    try {
      const callId = await f.call(),
        before = await f.sourceState(callId),
        t = await f.transfer(callId);
      await f.pool.query(
        "insert into call_capacity_reservations(operation_id,call_id,resource_type,scope_id,units) values($1,$2,'transfer_overlap','deployment',4)",
        [randomUUID(), callId]
      );
      await assert.rejects(
        mutateTransferOffer(f.pool, f.target.actor, t.offerId!, intent(f.target), "accept"),
        /capacity_exceeded/
      );
      const rejection = await f.offerApp.inject({
        method: "POST",
        url: `/agent/call-offers/${t.offerId}/accept`,
        headers: f.target.headers,
        payload: intent(f.target)
      });
      assert.equal(rejection.statusCode, 409, rejection.body);
      assert.equal(rejection.json().code, "capacity_exhausted");
      assert.equal(
        (await f.pool.query("select state from agent_call_slots where agent_id=$1", [f.target.id])).rows[0]
          .state,
        "free"
      );
      assert.equal((await f.pool.query("select count(*)::int n from call_operations")).rows[0].n, 0);
      assert.equal(
        (await f.pool.query("select count(*)::int n from call_participants where agent_id=$1", [f.target.id]))
          .rows[0].n,
        0
      );
      assert.equal(
        (await f.pool.query("select state from call_offers where id=$1", [t.offerId])).rows[0].state,
        "pending"
      );
      await assert.rejects(f.pool.query("delete from transfer_offer_mutations"), /immutable/);
      await assert.rejects(f.pool.query("update transfer_offer_mutations set response='{}'"), /immutable/);
      assert.deepEqual(await f.sourceState(callId), before);
      await runMigrations(f.pool);
      assert.equal((await f.pool.query("select count(*)::int n from transfer_offer_mutations")).rows[0].n, 1);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "G01.2 terminal source versus acceptance across workers in both commit orders never releases an accepted reservation",
  options,
  async () => {
    for (const first of ["transfer", "terminal"] as const) {
      const f = await fixture();
      try {
        const callId = await f.call(),
          before = await f.sourceState(callId),
          t = await f.transfer(callId);
        const requests = {
          transfer: { mode: "transfer", actor: f.target.actor, offerId: t.offerId, intent: intent(f.target) },
          terminal: { mode: "terminal", callId }
        };
        const winner = f.worker({ ...requests[first], hold: true }),
          loser = f.worker(requests[first === "transfer" ? "terminal" : "transfer"]);
        const [w, l] = await Promise.all([winner.wait("ready"), loser.wait("ready")]);
        winner.send("start");
        await winner.wait("claimed");
        loser.send("start");
        await assertBlocked(f.pool, l.backend, w.backend);
        winner.send("finish");
        const results = await Promise.all([winner.wait("result"), loser.wait("result")]);
        await Promise.all([winner.exit, loser.exit]);
        const row = (await f.pool.query("select * from call_transfers where id=$1", [t.transfer!.id]))
          .rows[0];
        assert.equal(row.state, first === "transfer" ? "connecting" : "canceled", JSON.stringify(results));
        if (first === "terminal") assert.equal(row.reason, "call_closed");
        const source = await f.sourceState(callId);
        assert.deepEqual(source.slot, before.slot);
        assert.deepEqual(source.participant, before.participant);
        assert.deepEqual(source.leg, before.leg);
        assert.ok(source.call.ended_at);
        const slot = (await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.target.id]))
          .rows[0];
        assert.equal(slot.state, first === "transfer" ? "connecting" : "free");
        assert.equal(
          (await f.pool.query("select count(*)::int n from call_execution_attempts")).rows[0].n,
          0
        );
        await f.report(`terminal-${first}`, { transfer: row, slot, results });
      } finally {
        await f.cleanup();
      }
    }
  }
);
