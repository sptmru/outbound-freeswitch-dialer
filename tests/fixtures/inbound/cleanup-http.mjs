// Actual authenticated product routes; no native production bootstrap is enabled.
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { registerDashboardRoutes } from "../../../apps/api/dist-test/dashboard/routes.js";
import { signAuthToken } from "../../../apps/api/dist-test/auth/tokens.js";
import { registerCookieCsrfProtection, SESSION_COOKIE_NAME } from "../../../apps/api/dist-test/security.js";
export async function cleanupHttp(f, { installed = true, wake = async () => {} } = {}) {
  const config = {
    JWT_SECRET: "c06-isolated-test-only-signing-secret",
    JWT_EXPIRES_SECONDS: 3600,
    PUBLIC_APP_URL: "https://desk.example.test",
    corsOrigins: [],
    FREESWITCH_ESL_ENABLED: true,
    CONTACT_MAX_ATTEMPTS: 3,
    CONTACT_RETRY_DELAY_SECONDS: 900,
    DEFAULT_PHONE_COUNTRY_CODE: "US"
  };
  const app = Fastify();
  await app.register(cookie);
  registerCookieCsrfProtection(app, config);
  app.setErrorHandler((e, _req, reply) =>
    e instanceof ZodError ? reply.code(400).send({ message: "Validation failed" }) : reply.send(e)
  );
  const wakes = [];
  registerDashboardRoutes(
    app,
    config,
    f.pool,
    undefined,
    undefined,
    installed
      ? {
          async wakeExecutor(id) {
            wakes.push(id);
            await wake(id);
          }
        }
      : undefined
  );
  const user = (await f.pool.query("select * from users where id=$1", [f.userId])).rows[0];
  const token = signAuthToken(config, {
    sub: user.id,
    email: user.email,
    role: user.role,
    ver: user.auth_version
  });
  const intent = () => ({
    deskSessionId: f.input.deskSessionId,
    expectedRevision: "1",
    bindingGeneration: "1",
    idempotencyKey: randomUUID()
  });
  return {
    app,
    token,
    cookieName: SESSION_COOKIE_NAME,
    wakes,
    intent,
    api(callId, action, body = { intent: intent() }, headers = { authorization: `Bearer ${token}` }) {
      return app.inject({ method: "POST", url: `/agent/calls/${callId}/${action}`, payload: body, headers });
    },
    close: () => app.close()
  };
}
export async function cleanupRecording(f, file = "/isolated/voicemail.wav") {
  const id = (
    await f.pool.query(
      `insert into recordings(campaign_id,name,file_path,runtime_file_path)
    values($1,'C06',$2,$2) returning id`,
      [f.campaignId, file]
    )
  ).rows[0].id;
  await f.pool.query("update campaigns set voicemail_recording_id=$2 where id=$1", [f.campaignId, id]);
  return id;
}
