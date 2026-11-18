// Disposable C07 product-schema/HTTP fixtures. Media and reconciliation are simulated.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import pg from "pg";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { cleanupFixture } from "./cleanup.mjs";
import { CallExecutor } from "../../../apps/api/dist-test/call-executor.js";
import { registerDashboardRoutes } from "../../../apps/api/dist-test/dashboard/routes.js";
import { signAuthToken } from "../../../apps/api/dist-test/auth/tokens.js";
import { registerCookieCsrfProtection } from "../../../apps/api/dist-test/security.js";
export async function supervisorFixture(config) {
  const f = await cleanupFixture(config);
  return {
    ...f,
    async actor() {
      const user = (
        await f.pool.query(
          "insert into users(email,name,role,password_hash) values($1,'C07 admin','admin','fixture') returning *",
          [`${randomUUID()}@example.test`]
        )
      ).rows[0];
      const username = `desk_supervisor_${randomUUID().replaceAll("-", "")}`;
      await f.pool.query(
        "insert into admin_supervisor_endpoints(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','C07',true)",
        [user.id, username]
      );
      const agent = (
        await f.pool.query(
          "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name,registered) values($1,$2,'fixture','fixture','C07',true) returning id",
          [user.id, `desk_${randomUUID().replaceAll("-", "")}`]
        )
      ).rows[0].id;
      await f.pool.query(
        "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
        [agent]
      );
      const desk = (
        await f.pool.query(
          `insert into agent_desk_sessions(agent_id,campaign_id,sip_username,binding_generation,ready,verified_endpoint,verified_generation,verified_at,expires_at)
   values($1,$2,$3,1,true,'sip:fixture@127.0.0.1',1,clock_timestamp(),clock_timestamp()+interval '1 hour') returning id`,
          [agent, f.campaignId, `desk_${randomUUID().replaceAll("-", "")}`]
        )
      ).rows[0].id;
      return {
        userId: user.id,
        version: user.auth_version,
        agentId: agent,
        username,
        deskSessionId: desk,
        campaignId: f.campaignId,
        endpoint: { sipUsername: username, route: `sofia/internal-webrtc/sip:${username}@127.0.0.2:5000` }
      };
    }
  };
}
export async function limitedExecutor(f, config) {
  const role = `c07exec_${randomUUID().replaceAll("-", "")}`,
    admin = new pg.Pool(config);
  await admin.query(`create role ${role} login connection limit 8`);
  await f.pool.query(
    `grant usage on schema ${f.schema} to ${role};grant all on all tables in schema ${f.schema} to ${role};grant usage,select on all sequences in schema ${f.schema} to ${role}`
  );
  const login = { ...config, user: role };
  if (login.connectionString) {
    const url = new URL(login.connectionString);
    url.username = role;
    login.connectionString = url.href;
  }
  const executor = await CallExecutor.create({ ...login, options: `-c search_path=${f.schema}` }, 0);
  return {
    executor,
    database: { ...login, options: `-c search_path=${f.schema}` },
    async close() {
      await executor.close();
      await admin.query(`drop owned by ${role}`);
      await admin.query(`drop role ${role}`);
      await admin.end();
    }
  };
}
export async function supervisorHttp(f, actor, { config = {}, adapter } = {}) {
  const cfg = {
    JWT_SECRET: "c07-isolated-test-signing-secret",
    JWT_EXPIRES_SECONDS: 3600,
    PUBLIC_APP_URL: "https://desk.example.test",
    corsOrigins: [],
    FREESWITCH_ESL_ENABLED: true,
    CONTACT_MAX_ATTEMPTS: 3,
    CONTACT_RETRY_DELAY_SECONDS: 900,
    DEFAULT_PHONE_COUNTRY_CODE: "US",
    ...config
  };
  const app = Fastify();
  await app.register(cookie);
  registerCookieCsrfProtection(app, cfg);
  app.setErrorHandler((e, _r, reply) =>
    e instanceof ZodError ? reply.code(400).send({ message: "Validation failed" }) : reply.send(e)
  );
  registerDashboardRoutes(app, cfg, f.pool, undefined, undefined, undefined, adapter);
  const user = (await f.pool.query("select * from users where id=$1", [actor.userId])).rows[0];
  const token = signAuthToken(cfg, {
    sub: user.id,
    email: user.email,
    role: user.role,
    ver: user.auth_version
  });
  return {
    app,
    token,
    api(
      action,
      id,
      { key = randomUUID(), mode = "whisper", headers = { authorization: `Bearer ${token}` } } = {}
    ) {
      return app.inject({
        method: action === "start" ? "POST" : action === "mode" ? "PATCH" : "DELETE",
        url: action === "start" ? `/admin/live-calls/${id}/supervisor` : `/admin/supervisor-sessions/${id}`,
        headers: { ...headers, "idempotency-key": key },
        ...(action === "mode" ? { payload: { mode } } : {})
      });
    },
    close: () => app.close()
  };
}
export async function mockSupervisorEsl(onCommand, { contact = () => "", exists = () => true } = {}) {
  const sockets = new Set(),
    sent = [],
    jobs = new Map();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.write("Content-Type: auth/request\n\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n\n")) {
        const end = buffer.indexOf("\n\n"),
          frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^(auth |event |connect)/.test(frame))
          socket.write("Content-Type: command/reply\nReply-Text: +OK accepted\n\n");
        else if (frame.startsWith("api ")) {
          const cmd = frame.slice(4),
            body = cmd.startsWith("sofia_contact") ? contact(cmd) : String(exists(cmd.split(" ")[1]));
          socket.write(`Content-Type: api/response\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`);
        } else {
          const job = frame.split("\nJob-UUID: ")[1];
          sent.push(frame);
          void onCommand(frame, job)
            .then((body) => {
              jobs.set(job, body);
              socket.write(`Content-Type: command/reply\nReply-Text: +OK\nJob-UUID: ${job}\n\n`);
              const event = `Event-Name: BACKGROUND_JOB\nEvent-UUID: ${randomUUID()}\nJob-UUID: ${job}\n\n${body}`;
              socket.write(
                `Content-Type: text/event-plain\nContent-Length: ${Buffer.byteLength(event)}\n\n${event}`
              );
            })
            .catch((e) => socket.destroy(e));
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    host: "127.0.0.1",
    port: server.address().port,
    password: "fixture",
    sent,
    jobs,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    }
  };
}
