import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import cookie from "@fastify/cookie";
import { cleanupFixture } from "../../../tests/fixtures/inbound/cleanup.mjs";
import { databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { signAuthToken } from "./auth/tokens.js";
import type { AppConfig } from "./config.js";
import { getCallDetail, getCallHistoryPage } from "./dashboard/responders.js";
import { getAdminAnalytics } from "./dashboard/analytics.js";
import { setManualCallStatus } from "./dashboard/manual-call-status.js";
import { __testing as events } from "./esl-events.js";

const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
const base = new Date("2026-11-18T01:00:00Z");
const at = (seconds: number) => new Date(+base + seconds * 1000);
async function fixture() {
  const f = await cleanupFixture(databaseConfig(testDatabaseUrl()));
  const queueId = (await f.pool.query("select id from inbound_queues where campaign_id=$1", [f.campaignId]))
    .rows[0].id;
  const bUser = (
    await f.pool.query(
      "insert into users(email,name,role,password_hash) values($1,'Recipient B','agent','fixture') returning *",
      [`${randomUUID()}@example.test`]
    )
  ).rows[0];
  const b = (
    await f.pool.query(
      "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name) values($1,$2,'fixture','fixture','B') returning id",
      [bUser.id, randomUUID()]
    )
  ).rows[0].id;
  const bDesk = (
    await f.pool.query(
      "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at) values($1,$2,1,$3,now()+interval '1 hour') returning id",
      [b, f.campaignId, randomUUID()]
    )
  ).rows[0].id;
  async function call(inbound = true, fallback = false, live = false, outcome = "answered") {
    const id = randomUUID();
    await f.pool.query(
      `insert into calls(id,campaign_id,agent_id,destination_number,normalized_destination_number,
      direction,state,outcome,created_at,started_at,answered_at,ended_at,original_did,calling_number,called_number,
      inbound_queue_id,arrived_at,queue_deadline_at,queue_exited_at,pstn_answered_at,agent_connected_at,fallback_started_at,inbound_end_reason)
      values($1,$2,$3,'+14155550100','+14155550100',$4,$5,$6,$7,$7,$8,$9,$10,'+14155550100','+12025550100',
      $11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        id,
        f.campaignId,
        live ? f.agentId : null,
        inbound ? "inbound" : "outbound",
        live ? "agent_connected" : "completed",
        live ? null : outcome,
        base,
        at(1),
        live ? null : at(90),
        inbound ? "+12025550100" : null,
        inbound ? queueId : null,
        inbound ? base : null,
        inbound ? at(30) : null,
        inbound ? at(10) : null,
        inbound ? at(1) : null,
        inbound && !fallback ? at(10) : null,
        inbound && fallback ? at(10) : null,
        inbound && !live
          ? fallback
            ? outcome === "not_answered"
              ? "no_answer_audio_completed"
              : "external_forward_completed"
            : "caller_hangup"
          : null
      ]
    );
    return id;
  }
  async function participant(
    callId: string,
    agent: string | null,
    start: number,
    end: number | null,
    role = "agent"
  ) {
    const id = randomUUID(),
      legId = randomUUID(),
      uuid = randomUUID();
    await f.pool.query(
      `insert into call_participants(id,call_id,role,agent_id,joined_at,connected_at,left_at)
      values($1,$2,$3,$4,$5,$5,$6)`,
      [id, callId, role, agent, at(start), end === null ? null : at(end)]
    );
    await f.pool.query(
      `insert into call_legs(id,call_id,participant_id,type,freeswitch_uuid,state,started_at,ended_at)
      values($1,$2,$3,$4,$5,case when $7::timestamptz is null then 'answered' else 'ended' end,$6,$7)`,
      [legId, callId, id, role, uuid, at(start), end === null ? null : at(end)]
    );
    return { id, legId, uuid };
  }
  async function offer(
    callId: string,
    state: string,
    reason: string,
    attempt = 1,
    agent = f.agentId,
    transferId: string | null = null
  ) {
    await f.pool.query(
      `insert into call_offers(call_id,kind,transfer_id,agent_id,attempt,desk_session_id,
      desk_revision,binding_generation,created_at,deadline_at,state,reason,closed_at)
      values($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,$10,$11)`,
      [
        callId,
        transferId ? "transfer" : "inbound",
        transferId,
        agent,
        attempt,
        agent === f.agentId ? f.input.deskSessionId : bDesk,
        transferId ? at(20) : base,
        transferId ? at(50) : at(20),
        state,
        reason,
        transferId ? at(25) : at(5)
      ]
    );
  }
  return { ...f, queueId, b, bUser, call, participant, offer };
}

test(
  "H03.1 DB/API: offer actions stay separate from customer result and timeout/flow result",
  options,
  async () => {
    const f = await fixture();
    try {
      const connected = await f.call();
      await f.offer(connected, "ignored", "user_ignored");
      await f.offer(connected, "expired", "deadline_elapsed", 2);
      await f.offer(connected, "ignored", "manual_outbound_started", 3);
      await f.offer(connected, "accepted", "accepted", 1, f.b);
      await f.participant(connected, f.b, 10, 90);
      const d = await getCallDetail(f.pool, connected);
      assert.equal(d?.call.outcome, "answered");
      assert.equal(d?.call.context?.queueExit, "agent_connected");
      assert.equal(d?.journey?.offers.total, 4);
      for (const action of ["play_audio", "forward_external"]) {
        const fallback = await f.call(
          true,
          true,
          false,
          action === "play_audio" ? "not_answered" : "answered"
        );
        await f.pool.query(
          `insert into call_operations(call_id,idempotency_scope,idempotency_key,request_fingerprint,
        command_kind,generation,command_uuid,state,deadline_at,created_at,resolved_at,resolution_evidence,result,request)
        values($1,$2,'0',$3,$4,1,$5,'succeeded',$6,$7,$8,'fixed job and native completion',$9,$10)`,
          [
            fallback,
            `inbound-fallback:${fallback}`,
            "a".repeat(64),
            action,
            randomUUID(),
            at(80),
            at(10),
            at(70),
            { outcome: action === "play_audio" ? "completed" : "connected" },
            { inboundFallback: true, step: 0 }
          ]
        );
        const detail = await getCallDetail(f.pool, fallback);
        assert.equal(detail?.call.context?.queueExit, "timeout");
        assert.equal(detail?.call.context?.queueWaitMs, 10000);
        assert.equal(detail?.call.context?.flowOutcome, action === "play_audio" ? "completed" : "connected");
        assert.equal(detail?.journey?.steps.items[0].action, action);
        assert.equal(detail?.call.outcome, action === "play_audio" ? "not_answered" : "answered");
      }
      const live = await f.call(true, false, true);
      const source = await f.participant(live, f.agentId, 10, null);
      const transferId = randomUUID();
      await f.pool.query(
        `insert into call_transfers(id,call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,
        state,created_at,deadline_at,closed_at,reason) values($1,$2,1,$3,$4,$5,'declined',$6,$7,$8,'manual_outbound_started')`,
        [transferId, live, f.agentId, source.id, f.b, at(20), at(50), at(25)]
      );
      await f.offer(live, "declined", "manual_outbound_started", 1, f.b, transferId);
      const liveDetail = await getCallDetail(f.pool, live);
      assert.equal(liveDetail?.call.state, "agent_connected");
      assert.equal(liveDetail?.call.outcome, null);
      assert.equal(liveDetail?.journey?.transfers.items[0].reason, "manual_outbound_started");
      assert.equal(liveDetail?.journey?.participants.items[0].leftAt, null);

      const before = (await f.pool.query("select * from calls where id=$1", [live])).rows[0];
      await getCallDetail(f.pool, live);
      assert.deepEqual(
        (await f.pool.query("select * from calls where id=$1", [live])).rows[0],
        before,
        "history is read-only"
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "H03.2 DB: inbound/outbound A-B-A, external party and overlapping snapshots retain one call and interval attribution",
  options,
  async () => {
    const f = await fixture();
    try {
      for (const inbound of [true, false]) {
        const call = await f.call(inbound);
        const a = await f.participant(call, f.agentId, 10, 30);
        const b = await f.participant(call, f.b, 30, 50);
        await f.participant(call, f.agentId, 50, 70);
        for (const [attempt, source, recipient, participant, offset] of [
          [1, f.agentId, f.b, a.id, 30],
          [2, f.b, f.agentId, b.id, 50]
        ] as const) {
          await f.pool.query(
            `insert into call_transfers(call_id,attempt,source_agent_id,source_participant_id,recipient_agent_id,
            state,created_at,deadline_at,closed_at,reason) values($1,$2,$3,$4,$5,'completed',$6,$7,$8,'rebridge_confirmed')`,
            [call, attempt, source, participant, recipient, at(offset - 10), at(offset + 10), at(offset)]
          );
        }
        await f.participant(call, f.agentId, 60, 70); // defensive overlapping evidence
        await f.participant(call, null, 70, 85, "external");
        await f.pool.query(
          "insert into call_leg_media_stats(call_id,call_leg_id,leg_type,freeswitch_uuid,captured_at,source_event_name,inbound_media_packet_count,outbound_media_packet_count) values($1,$2,'agent',$3,$4,'CHANNEL_HANGUP_COMPLETE',100,120)",
          [call, b.legId, b.uuid, at(50)]
        );
        await f.pool.query(
          "insert into call_participant_browser_media_stats(call_id,participant_id,schema_version,started_at,ended_at,sample_count) values($1,$2,1,$3,$4,7)",
          [call, b.id, at(30), at(50)]
        );
        await f.pool.query("update calls set agent_id=$2 where id=$1", [call, f.b]);
        const detail = await getCallDetail(f.pool, call);
        assert.equal(
          detail?.journey?.participants.items.find((p) => p.id === b.id)?.media?.inboundPackets,
          100
        );
        assert.equal(
          detail?.journey?.participants.items.find((p) => p.id === b.id)?.browserMedia?.sampleCount,
          7
        );
        assert.equal(detail?.call.context?.agentTalkMs, 60000);
        assert.equal(detail?.mediaQuality.length, 0, "legacy projection is not attributed to the recipient");
      }
      const analytics = await getAdminAnalytics(
        f.pool,
        { from: at(-1), to: at(100), campaignId: f.campaignId, timeZone: "UTC" },
        { maxAttempts: 3, retryDelaySeconds: 0 }
      );
      assert.equal(analytics.summary.attempts, 1);
      assert.equal(analytics.inbound?.calls, 1);
      assert.equal(analytics.inbound?.transfers, 2);
      assert.equal(analytics.summary.averageTalkSeconds, 75);
      assert.equal(analytics.campaignPerformance[0].attempts, 1);
      assert.equal(
        analytics.agentPerformance.find((a) => a.id === f.agentId)?.attempts,
        1,
        "initial agent owns the outbound attempt"
      );
      assert.equal(analytics.agentPerformance.find((a) => a.id === f.b)?.attempts, 0);
      for (const direction of ["inbound", "outbound"]) {
        const a = analytics.participation?.find((p) => p.agentId === f.agentId && p.direction === direction);
        const b = analytics.participation?.find((p) => p.agentId === f.b && p.direction === direction);
        assert.equal(a?.connectedMs, 40000);
        assert.equal(a?.calls, 1);
        assert.equal(b?.connectedMs, 20000);
        assert.equal(b?.mediaLegs, 1);
        assert.equal(b?.browserSegments, 1);
      }
      const page = await getCallHistoryPage(f.pool, { page: 1, pageSize: 25 });
      assert.equal(page.total, 2);
      assert.equal(new Set(page.items.map((c) => c.id)).size, 2);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "H03.3 API/DB: filters, CSV parity, access and immutable manual correction survive late events",
  options,
  async () => {
    const f = await fixture(),
      app = Fastify();
    try {
      await f.pool.query("update users set role='admin' where id=$1", [f.userId]);
      const user = (await f.pool.query("select * from users where id=$1", [f.userId])).rows[0];
      const config = {
        JWT_SECRET: "h03-isolated-secret",
        JWT_EXPIRES_SECONDS: 3600,
        CALL_HISTORY_EXPORT_MAX_ROWS: 1500
      } as AppConfig;
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof ZodError) return reply.code(400).send({ message: "Invalid request" });
        throw error;
      });
      await app.register(cookie);
      registerDashboardRoutes(app, config, f.pool);
      const headers = {
        authorization: `Bearer ${signAuthToken(config, { sub: user.id, email: user.email, role: user.role, ver: user.auth_version })}`
      };
      const inbound = await f.call();
      await f.participant(inbound, f.agentId, 10, 30);
      await f.participant(inbound, f.b, 30, 60);
      const outbound = await f.call(false);
      await f.pool.query("update calls set agent_id=$2 where id=$1", [outbound, f.agentId]);
      assert.equal(
        (await setManualCallStatus(f.pool, { callId: outbound, outcome: "busy", userId: f.userId })).status,
        "updated"
      );
      await f.pool.query("update calls set state='failed',outcome='failed' where id=$1", [outbound]);
      const lateUuid = randomUUID();
      await f.pool.query(
        "insert into call_legs(call_id,type,freeswitch_uuid,state) values($1,'customer',$2,'ended')",
        [outbound, lateUuid]
      );
      const late = {
        body: "",
        headers: {
          "event-name": "CHANNEL_HANGUP_COMPLETE",
          "event-uuid": randomUUID(),
          "unique-id": lateUuid,
          variable_outbound_dialer_call_id: outbound,
          "hangup-cause": "NORMAL_CLEARING"
        }
      };
      await events.persistFreeSwitchEvent(config, f.pool, late);
      await events.persistFreeSwitchEvent(config, f.pool, late);
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int as n from call_events where call_id=$1 and event_type='freeswitch_channel_hangup_complete'",
            [outbound]
          )
        ).rows[0].n,
        1
      );

      const suffix = `direction=inbound&did=%2B12025550100&queueId=${f.queueId}&agentId=${f.bUser.id}`;
      const response = await app.inject({ url: `/admin/calls?${suffix}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(
        response.json().items.map((c: { id: string }) => c.id),
        [inbound]
      );
      const csv = await app.inject({ url: `/admin/calls/export.csv?${suffix}`, headers });
      assert.equal(csv.statusCode, 200, csv.body);
      assert.ok(csv.body.includes(inbound));
      assert.ok(!csv.body.includes(outbound));
      assert.equal(csv.body.trim().split("\n").length, 2);
      assert.match(csv.body, /queue_exit/);
      assert.match(csv.body, /participants/);
      assert.ok(csv.body.includes("agent"));
      const corrected = await app.inject({ url: `/admin/calls/${outbound}`, headers });
      assert.equal(corrected.statusCode, 200, corrected.body);
      assert.equal(corrected.json().call.outcome, "busy");
      assert.ok(corrected.json().call.context.manualCorrectionAt);
      assert.equal((await app.inject({ url: "/admin/calls?direction=wrong", headers })).statusCode, 400);
      const denied = {
        authorization: `Bearer ${signAuthToken(config, { sub: f.bUser.id, email: f.bUser.email, role: f.bUser.role, ver: f.bUser.auth_version })}`
      };
      for (const url of ["/admin/calls", `/admin/calls/${inbound}`, "/admin/calls/export.csv"])
        assert.equal((await app.inject({ url, headers: denied })).statusCode, 403);
    } finally {
      await app.close();
      await f.cleanup();
    }
  }
);
