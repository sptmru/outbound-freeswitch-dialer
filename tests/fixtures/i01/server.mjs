// Disposable browser integration. Product Fastify handlers and PostgreSQL mutations
// run normally. This fixture supplies the staged Desk projection and media effects.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { ZodError } from "zod";
import { cleanupFixture } from "../inbound/cleanup.mjs";
import { databaseConfig, testDatabaseUrl } from "../inbound/database.mjs";
import { registerAuthRoutes } from "../../../apps/api/dist-test/auth/routes.js";
import { hashSecret } from "../../../apps/api/dist-test/auth/passwords.js";
import { encryptSecret } from "../../../apps/api/dist-test/auth/crypto.js";
import { registerDashboardRoutes } from "../../../apps/api/dist-test/dashboard/routes.js";
import { DeskSessions } from "../../../apps/api/dist-test/desk-sessions.js";
import { registerCookieCsrfProtection } from "../../../apps/api/dist-test/security.js";
import { createLiveEventHub, registerLiveEventRoutes } from "../../../apps/api/dist-test/live-events.js";
import { importIngressRecord } from "../../../apps/api/dist-test/inbound-ingress.js";
import { admitInboundQueue, persistInboundQueueEvent } from "../../../apps/api/dist-test/inbound-queue.js";
import { dispatchInboundOffers, readInboundOffer } from "../../../apps/api/dist-test/inbound-dispatcher.js";
import { settleInboundConnection } from "../../../apps/api/dist-test/inbound-connection.js";
import {
  prepareTransferCommands,
  settleTransferConnection
} from "../../../apps/api/dist-test/transfer-connection.js";
import {
  persistCoordinatedCallEvent,
  reconcileCoordinatedCallCleanup
} from "../../../apps/api/dist-test/call-cleanup.js";

const webPort = 4183;
const origin = `http://127.0.0.1:${webPort}`;
const web = fileURLToPath(new URL("../../../apps/web", import.meta.url));
const phone = fileURLToPath(new URL("./phone.ts", import.meta.url));
export const password = "isolated-i01-password";

export async function browserFixture() {
  const dbUrl = new URL(testDatabaseUrl());
  assert.ok(dbUrl.searchParams.has("host"), "Use npm run test:inbound:browser:isolated");
  const f = await cleanupFixture(databaseConfig(dbUrl.href));
  const { pool } = f;
  const directory = await mkdtemp(join(tmpdir(), "outbound-i01-media-"));
  const app = Fastify({ forceCloseConnections: true });
  const hub = createLiveEventHub();
  const wakeIds = [];
  const pendingAuto = new Map();
  const journalId = randomUUID();
  let ingressSequence = 0;
  let vite;
  const query = (sql, values) => pool.query(sql, values).then((r) => r.rows);
  const one = (sql, values) => query(sql, values).then(([row]) => row);
  const publish = () =>
    hub.publish({ type: "refresh", source: "database", occurredAt: new Date().toISOString() });
  const close = async () => {
    await app.close();
    try {
      await vite?.close();
    } finally {
      await f.cleanup();
      await rm(directory, { force: true, recursive: true });
    }
  };
  const config = {
    JWT_SECRET: "isolated-i01-signing-secret-only-for-browser-fixtures",
    JWT_EXPIRES_SECONDS: 3600,
    SIP_SECRET_ENCRYPTION_KEY: "i01-disposable-encryption-key-for-synthetic-data",
    PUBLIC_APP_URL: origin,
    corsOrigins: [],
    DEFAULT_PHONE_COUNTRY_CODE: "US",
    CONTACT_MAX_ATTEMPTS: 3,
    CONTACT_RETRY_DELAY_SECONDS: 900,
    CALL_HISTORY_EXPORT_MAX_ROWS: 100,
    MEDIA_TICKET_TTL_SECONDS: 60,
    CALL_RECORDINGS_STORAGE_DIR: directory,
    FREESWITCH_ESL_ENABLED: true,
    FREESWITCH_GENERATED_CONFIG_DIR: directory,
    FREESWITCH_DOMAIN: "i01.example.test",
    FREESWITCH_ESL_HOST: "127.0.0.1",
    FREESWITCH_ESL_PORT: 1
  };
  const deskSessions = new DeskSessions(pool, config);
  try {
    const hash = await hashSecret(password);
    const sipSecret = encryptSecret(config, password);
    const campaignId = f.campaignId;
    await query("update campaigns set name='I01 campaign' where id=$1", [campaignId]);
    const otherId = (
      await one(
        "insert into campaigns(name,status,manual_dialing_enabled) values('Other campaign','active',true) returning id"
      )
    ).id;
    const queueId = (
      await one("update inbound_queues set name='I01 queue' where campaign_id=$1 returning id", [campaignId])
    ).id;
    await query("update users set email='alice@example.test',name='Alice',password_hash=$1 where id=$2", [
      hash,
      f.userId
    ]);
    await query(
      "update agents set display_name='Alice',status='ready',sip_password_encrypted=$2 where id=$1",
      [f.agentId, sipSecret]
    );
    await verifyFixtureEndpoint(f.input.deskSessionId);
    const alice = {
      id: f.agentId,
      userId: f.userId,
      email: "alice@example.test",
      sessionId: f.input.deskSessionId
    };

    async function verifyFixtureEndpoint(sessionId) {
      await query(
        "update agent_desk_sessions set actor_auth_version=1,verified_endpoint='sofia/internal-webrtc/sip:fixture@127.0.0.1:5060',endpoint_pin='sofia/internal-webrtc/sip:fixture@127.0.0.1:5060' where id=$1",
        [sessionId]
      );
    }
    async function actor(name, selected = campaignId, role = "agent") {
      const email = `${name.toLowerCase()}@example.test`;
      const user = await one(
        "insert into users(email,name,role,password_hash) values($1,$2,$3,$4) returning id",
        [email, name, role, hash]
      );
      if (role === "admin") return { userId: user.id, email };
      const agent = await one(
        "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,$3,$4,$5,true) returning id",
        [user.id, `agent_${name.toLowerCase()}`, hash, sipSecret, name]
      );
      await query(
        "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
        [agent.id]
      );
      const session = await one(
        `insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at,ready,verified_endpoint,verified_generation,verified_at)
        values($1,$2,1,$3,clock_timestamp()+interval '30 minutes',true,'sip:fixture@127.0.0.1',1,clock_timestamp()) returning id`,
        [agent.id, selected, `desk_${name.toLowerCase()}`]
      );
      await verifyFixtureEndpoint(session.id);
      return { id: agent.id, userId: user.id, email, sessionId: session.id, campaignId: selected };
    }

    const bob = await actor("Bob");
    const admin = await actor("Admin", campaignId, "admin");
    // Only the optional, still-staged coordination projection is supplied here.
    // All mutations use the actual authenticated application routes.
    await app.register(cookie);
    registerCookieCsrfProtection(app, config);
    app.setErrorHandler((error, _request, reply) =>
      error instanceof ZodError ? reply.code(400).send({ message: "Validation failed" }) : reply.send(error)
    );
    app.addHook("preSerialization", async (request, _reply, desk) => {
      if (
        !["/agent/desk", "/agent/availability"].includes(request.routeOptions.url) ||
        !desk?.user ||
        !desk.campaign
      )
        return desk;
      const owner = await one(
        `select a.id as agent_id,u.auth_version,d.id,d.campaign_id from agents a
         join users u on u.id=a.user_id
         join agent_desk_sessions d on d.agent_id=a.id and d.revoked_at is null
         where a.user_id=$1`,
        [desk.user.id]
      );
      if (!owner) return desk;
      const identity = { userId: desk.user.id, agentId: owner.agent_id, authVersion: owner.auth_version };
      const binding = await deskSessions.read(identity, owner.id);
      if (!binding) return desk;
      const { revision, session } = binding;
      const sameCampaign = owner.campaign_id === desk.campaign.id;
      const offer = sameCampaign ? (await readInboundOffer(pool, identity, owner.id)).offer : null;
      const slot = await one("select * from agent_call_slots where agent_id=$1", [owner.agent_id]);
      const transfer = await one(
        `select id,call_id as "callId",source_agent_id as "sourceAgentId",
          recipient_agent_id as "recipientAgentId",state,deadline_at as "deadlineAt"
         from call_transfers where source_agent_id=$1 or recipient_agent_id=$1
         order by created_at desc,id desc limit 1`,
        [owner.agent_id]
      );
      const autoNextIntent =
        (await one(
          `select id,source_call_id as "sourceCallId",state,reason,started_call_id as "callId"
         from agent_auto_next_intents where agent_id=$1 and campaign_id=$2
         order by created_at desc,id desc limit 1`,
          [owner.agent_id, desk.campaign.id]
        )) ?? pendingAuto.get(owner.agent_id);
      const action = (allowed, reason) => ({ allowed, reason: allowed ? null : reason });
      const idle = sameCampaign && slot.state === "free" && desk.availability.status === "available";
      return {
        ...desk,
        coordination: {
          contractVersion: 1,
          revision,
          session,
          slot: {
            state: slot.state,
            callId: slot.call_id,
            reservationId: slot.reservation_id,
            generation: slot.generation
          },
          offer,
          transfer: transfer ?? null,
          autoNextIntent: autoNextIntent ?? null,
          actions: {
            manualStart: action(idle, "unavailable"),
            autoNext: action(idle && !offer, offer ? "incoming_pending" : "unavailable"),
            accept: action(Boolean(offer && idle), "unavailable"),
            ignore: action(Boolean(offer && idle), "unavailable"),
            transfer: action(sameCampaign && slot.state === "active", "unavailable")
          }
        }
      };
    });
    app.addHook("onResponse", async (req, reply) => {
      if (!["GET", "HEAD"].includes(req.method) && reply.statusCode < 400 && !req.url.startsWith("/auth/"))
        publish();
    });
    const wake = {
      async wakeExecutor(id) {
        wakeIds.push(id);
      }
    };
    registerAuthRoutes(app, config, pool);
    registerDashboardRoutes(app, config, pool, undefined, wake, wake, undefined, wake, wake);
    registerLiveEventRoutes(app, config, pool, hub);
    const api = await app.listen({ host: "127.0.0.1", port: 0 });
    vite = await createServer({
      root: web,
      configFile: false,
      envDir: false,
      define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("/api") },
      plugins: [
        react(),
        {
          name: "i01-fake-phone",
          enforce: "pre",
          resolveId(source, importer) {
            if (source === "./softphone" && importer?.replaceAll("\\", "/").endsWith("/apps/web/src/App.tsx"))
              return phone;
          }
        }
      ],
      server: {
        host: "127.0.0.1",
        port: webPort,
        strictPort: true,
        fs: { allow: [join(web, "../..")] },
        proxy: { "/api": { target: api, rewrite: (path) => path.replace(/^\/api/, "") } }
      }
    });
    await vite.listen();

    async function event(id, name, extra = {}) {
      await persistInboundQueueEvent(pool, {
        variable_outbound_dialer_ingress_uuid: id,
        "unique-id": id,
        "event-name": name,
        "event-uuid": randomUUID(),
        ...extra
      });
    }
    async function dispatch(...agents) {
      for (const agent of agents) await dispatchInboundOffers(pool, agent.id);
      publish();
    }
    async function arrive(number = "+14155550199", agents = [alice, bob], offerTimeoutMs = 20_000) {
      const id = randomUUID();
      await importIngressRecord(pool, {
        uuid: id,
        journalId,
        sequence: ++ingressSequence,
        arrivedUs: Date.now() * 1000,
        did: "+12025550100",
        routeRevision: "1",
        numberId: randomUUID(),
        queueId,
        queueRevision: "1",
        campaignId,
        timeoutMs: 60_000,
        routeData: Buffer.from(
          JSON.stringify({
            queue_timeout_ms: 60_000,
            max_waiting_calls: 40,
            offer_timeout_ms: offerTimeoutMs
          })
        ).toString("base64url"),
        callingNumber: number,
        terminalUs: null,
        terminalReason: null
      });
      const op = await admitInboundQueue(pool, id);
      assert.ok(op, "Expected queue admission");
      await event(id, "CUSTOM", {
        "event-subclass": "outbound_dialer::inbound_waiting_started",
        "outbound-dialer-operation-id": op.id
      });
      await resolve(op.id);
      await dispatch(...agents);
      return id;
    }
    async function resolve(id, state = "succeeded") {
      await query(
        "update call_operations set state=$2,result='{}',resolved_at=clock_timestamp(),resolution_evidence='I01 simulated media boundary' where id=$1 and resolved_at is null",
        [id, state]
      );
    }
    async function endInbound(id) {
      await event(id, "CHANNEL_DESTROY", { "hangup-cause": "NORMAL_CLEARING" });
      publish();
    }
    async function connectInbound(id) {
      const attempt = await one(
        `select a.operation_id,a.bridge_operation_id,l.freeswitch_uuid from inbound_connection_attempts a
         join call_legs l on l.call_id=a.call_id and l.participant_id=a.participant_id where a.call_id=$1`,
        [id]
      );
      // An explicitly simulated sender receipt allows the genuine bridge event
      // reducer and slot transition to consume the exact accepted leg.
      await query(
        "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat) values($1,$2,pg_backend_pid(),0,0)",
        [attempt.bridge_operation_id, randomUUID()]
      );
      await resolve(attempt.bridge_operation_id);
      await event(id, "CHANNEL_BRIDGE", { "other-leg-unique-id": attempt.freeswitch_uuid });
      for (const op of await query(
        "select id from call_operations where call_id=$1 and request->>'rootOperationId'=$2 and resolved_at is null",
        [id, attempt.operation_id]
      ))
        await resolve(op.id);
      await settleInboundConnection(pool, attempt.operation_id);
      publish();
    }
    async function seedConnected(inbound) {
      const call = await f.seed({ inbound });
      await query("update agent_call_slots set state='active' where agent_id=$1", [alice.id]);
      await query("update call_participants set connected_at=clock_timestamp() where id=$1", [
        call.participantId
      ]);
      return call;
    }
    async function finishTransfer(call, rootId, success) {
      await prepareTransferCommands(pool, rootId);
      if (success) {
        for (const op of await query(
          "select id from call_operations where call_id=$1 and resolved_at is null",
          [call.callId]
        ))
          await resolve(op.id);
        await settleTransferConnection(pool, rootId);
        await persistCoordinatedCallEvent(pool, {
          callId: call.callId,
          legUuid: call.agentUuid,
          eventName: "CHANNEL_HANGUP_COMPLETE",
          eventUuid: randomUUID()
        });
      } else {
        await resolve(rootId, "failed");
      }
      for (let i = 0; i < 5; i++) {
        await settleTransferConnection(pool, rootId);
        for (const op of await query(
          "select id from call_operations where call_id=$1 and resolved_at is null and request->>'transferAction' is not null",
          [call.callId]
        ))
          await resolve(op.id);
      }
      await reconcileCoordinatedCallCleanup(pool, call.callId);
      publish();
    }
    async function lead(name, number, campaign = campaignId) {
      return one(
        `insert into contacts(campaign_id,display_name,phone_number,normalized_phone_number,status)
        values($1,$2,$3,$3,'new') returning id`,
        [campaign, name, number]
      );
    }
    async function offerAutomaticNext(agent, contactId) {
      await query("update campaigns set auto_advance_to_next_lead_enabled=true where id=$1", [campaignId]);
      const source = await one(
        `insert into calls(campaign_id,agent_id,contact_id,destination_number,normalized_destination_number,state,outcome,ended_at)
         values($1,$2,$3,'+14155550123','+14155550123','completed','answered',clock_timestamp()) returning id`,
        [campaignId, agent.id, contactId]
      );
      await query("update contacts set status='completed' where id=$1", [contactId]);
      pendingAuto.set(agent.id, {
        id: randomUUID(),
        sourceCallId: source.id,
        state: "pending",
        reason: null,
        callId: null
      });
      publish();
      return source.id;
    }
    async function wavFile(id) {
      const wav = Buffer.alloc(16044);
      wav.write("RIFF");
      wav.writeUInt32LE(16036, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24);
      wav.writeUInt32LE(16000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(16000, 40);
      const file = join(directory, `${id}.wav`);
      await writeFile(file, wav);
      return { file, bytes: wav.length };
    }
    async function recording(callId) {
      const { file, bytes } = await wavFile(callId);
      await query(
        `update calls set call_recording_status='available',call_recording_path=$2,
        call_recording_duration_seconds=1,call_recording_file_size_bytes=$3 where id=$1`,
        [callId, file, bytes]
      );
    }
    async function inboundAudio() {
      const id = randomUUID();
      const { file, bytes } = await wavFile(id);
      await query(
        `insert into recordings(id,campaign_id,name,file_path,runtime_file_path,duration_seconds,file_size_bytes)
         values($1,$2,'I01 greeting',$3,$3,1,$4)`,
        [id, campaignId, file, bytes]
      );
      return id;
    }
    return {
      origin,
      close,
      query,
      one,
      publish,
      wakeIds,
      alice,
      bob,
      admin,
      campaignId,
      otherId,
      queueId,
      actor,
      arrive,
      dispatch,
      endInbound,
      connectInbound,
      seedConnected,
      finishTransfer,
      lead,
      offerAutomaticNext,
      recording,
      inboundAudio
    };
  } catch (error) {
    await close();
    throw error;
  }
}
