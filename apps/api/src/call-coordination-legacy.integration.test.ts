import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import pg from "pg";
import { databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { encryptSecret } from "./auth/crypto.js";
import { signAuthToken } from "./auth/tokens.js";
import type { AppConfig } from "./config.js";
import { runMigrations } from "./db.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { reserveAgentCallSlot } from "./agent-call-slots.js";

test(
  "B05.3 real PostgreSQL/API legacy starts preserve pending offer, slot, source and attempts",
  {
    skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
    timeout: 30000
  },
  async () => {
    const schema = `b05_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
    const pool = new pg.Pool(databaseConfig(testDatabaseUrl(), schema));
    const directory = await mkdtemp(join(tmpdir(), "b05-legacy-"));
    const app = Fastify();
    let eslConnections = 0;
    const esl = createServer((socket) => {
      eslConnections++;
      socket.destroy();
    });
    esl.listen(0, "127.0.0.1");
    await once(esl, "listening");
    const address = esl.address();
    assert.ok(address && typeof address !== "string");
    const config = {
      JWT_SECRET: "b05-isolated-database-fixture",
      JWT_EXPIRES_SECONDS: 3600,
      FREESWITCH_GENERATED_CONFIG_DIR: directory,
      FREESWITCH_DOMAIN: "fixture.invalid",
      FREESWITCH_ESL_ENABLED: true,
      FREESWITCH_ESL_HOST: "127.0.0.1",
      FREESWITCH_ESL_PORT: address.port,
      DEFAULT_PHONE_COUNTRY_CODE: "US",
      CONTACT_MAX_ATTEMPTS: 3,
      CONTACT_RETRY_DELAY_SECONDS: 900
    } as AppConfig;
    try {
      await admin.query(`create schema ${schema}`);
      await runMigrations(pool);
      const user = (
        await pool.query(
          "insert into users(email,name,role,password_hash) values('b05@example.test','B05','agent','fixture') returning *"
        )
      ).rows[0];
      const agentId = (
        await pool.query(
          "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,'b05','fixture',$2,'B05',true) returning id",
          [user.id, encryptSecret(config, "b05-fixture-sip")]
        )
      ).rows[0].id;
      const campaignId = (
        await pool.query(
          "insert into campaigns(name,status,manual_dialing_enabled) values('B05','active',true) returning id"
        )
      ).rows[0].id;
      const contactId = (
        await pool.query(
          "insert into contacts(campaign_id,display_name,phone_number,normalized_phone_number) values($1,'B05','+14155550100','+14155550100') returning id",
          [campaignId]
        )
      ).rows[0].id;
      const sessionId = (
        await pool.query(
          "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at) values($1,$2,1,'b05-session',now()+interval '1 hour') returning id",
          [agentId, campaignId]
        )
      ).rows[0].id;
      const queueId = (
        await pool.query("insert into inbound_queues(campaign_id,name) values($1,'B05') returning id", [
          campaignId
        ])
      ).rows[0].id;
      const callId = (
        await pool.query(
          "insert into calls(campaign_id,destination_number,normalized_destination_number,state,direction,original_did,calling_number,called_number,inbound_queue_id,arrived_at,queue_deadline_at) values($1,'+14155550100','+14155550100','queued','inbound','+14155550101','+14155550100','+14155550101',$2,now(),now()+interval '60 seconds') returning id",
          [campaignId, queueId]
        )
      ).rows[0].id;
      await pool.query(
        "insert into call_offers(call_id,agent_id,kind,attempt,desk_session_id,desk_revision,binding_generation,deadline_at) values($1,$2,'inbound',1,$3,1,1,now()+interval '20 seconds')",
        [callId, agentId, sessionId]
      );
      await pool.query(
        "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
        [agentId]
      );
      const snapshot = async () =>
        Object.fromEntries(
          await Promise.all(
            [
              "calls",
              "call_offers",
              "call_offer_exclusions",
              "call_transfers",
              "call_operations",
              "agent_auto_next_intents",
              "contacts",
              "agent_call_slots",
              "call_participants",
              "call_legs",
              "agents"
            ].map(async (table) => {
              const order =
                table === "call_offer_exclusions"
                  ? "call_id,agent_id"
                  : table === "agent_call_slots"
                    ? "agent_id"
                    : "id";
              return [table, (await pool.query(`select * from ${table} order by ${order}`)).rows];
            })
          )
        );
      registerDashboardRoutes(app, config, pool);
      const token = signAuthToken(config, { sub: user.id, email: user.email, role: "agent", ver: 1 });
      async function assertRejectedStarts() {
        const before = await snapshot();
        for (const [url, payload] of [
          ["/agent/call-next", { campaignId }],
          ["/agent/manual-dial/start", { campaignId, phoneNumber: "+14155550100" }],
          [`/agent/leads/${contactId}/call`, {}]
        ] as const) {
          const response = await app.inject({
            method: "POST",
            url,
            headers: { authorization: `Bearer ${token}` },
            payload
          });
          assert.equal(response.statusCode, 409, response.body);
          assert.equal(response.json().code, "legacy_initiator_required", response.body);
          assert.deepEqual(await snapshot(), before);
          assert.equal(eslConnections, 0);
        }
      }
      await assertRejectedStarts();
      // With the offer closed and controller revoked, a pre-SIP outbound/transfer
      // reservation must still refuse legacy starts, including an ownerless call.
      await pool.query(
        "update call_offers set state='canceled',reason='fixture_closed',closed_at=now() where call_id=$1",
        [callId]
      );
      await pool.query("update agent_desk_sessions set revoked_at=now() where id=$1", [sessionId]);
      const reservedCallId = (
        await pool.query(
          "insert into calls(campaign_id,destination_number,normalized_destination_number,state) values($1,'+14155550100','+14155550100','created') returning id",
          [campaignId]
        )
      ).rows[0].id;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const reservation = await reserveAgentCallSlot(client, agentId, reservedCallId);
        assert.equal(reservation?.generation, "2");
        await client.query("commit");
      } finally {
        client.release();
      }
      await assertRejectedStarts();
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => esl.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
      try {
        await admin.query(`drop schema if exists ${schema} cascade`);
      } finally {
        await admin.end();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
);
