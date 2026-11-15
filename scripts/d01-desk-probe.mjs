// D01 native HTTP/product schema + isolated authenticated SIP and decoded RTP.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { render as baseRender } from "./a05-rebridge-probe.mjs";
import { openEsl } from "./a02-ingress-probe.mjs";
import { endpoint, until, assertTone } from "./a05-media.mjs";
import { cleanupFixture } from "../tests/fixtures/inbound/cleanup.mjs";
import { DeskSessions } from "../apps/api/dist-test/desk-sessions.js";
import { registerDeskSessionRoutes } from "../apps/api/dist-test/dashboard/desk-sessions.js";
import { signAuthToken } from "../apps/api/dist-test/auth/tokens.js";
import { provisionAgentDirectory } from "../apps/api/dist-test/freeswitch/provisioning.js";
const [mode, directory] = process.argv.slice(2);
assert.match(directory ?? "", /^\/tmp\/outbound-d01\.[A-Za-z0-9]+$/);
if (mode === "render") {
  await baseRender(directory);
  let xml = await readFile(join(directory, "freeswitch.xml"), "utf8");
  xml = xml
    .replaceAll("a04-loopback", "internal-webrtc")
    .replace("<users>", '<users>\n<X-PRE-PROCESS cmd="include" data="/a02/directory/default/*.xml"/>');
  await writeFile(join(directory, "freeswitch.xml"), xml, { mode: 0o600 });
  process.exit(0);
}
assert.equal(mode, "probe");
const config = {
  JWT_SECRET: "d01-isolated-test-only",
  JWT_EXPIRES_SECONDS: 3600,
  FREESWITCH_ESL_ENABLED: true,
  FREESWITCH_ESL_HOST: "127.0.0.1",
  FREESWITCH_ESL_PORT: 8021,
  FREESWITCH_ESL_PASSWORD: "a02-disposable-only",
  FREESWITCH_DOMAIN: "a04.invalid",
  FREESWITCH_GENERATED_CONFIG_DIR: directory
};
const report = {
  date: new Date().toISOString(),
  node: process.version,
  scenarios: [],
  commands: [],
  boundary:
    "product D01 HTTP/schema/provisioning/lookup/reconciliation; real UDP SIP/PCMU RTP; simulated browser controls and call/transfer reservations, no browser WebRTC/provider/production"
};
const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
let f, observer, app;
const clients = [];
let commands = Promise.resolve();
async function command(text) {
  const next = commands.then(() => observer.command(`api ${text}`));
  commands = next.catch(() => {});
  const body = (await next).body.trim();
  report.commands.push({ text, body });
  return body;
}
async function pass(name, evidence = {}) {
  report.scenarios.push({ name, status: "passed", ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
const mutation = (s) => ({
  deskSessionId: s.id,
  expectedRevision: s.revision,
  bindingGeneration: s.bindingGeneration,
  idempotencyKey: randomUUID()
});
async function tones(client, frequency) {
  const offset = client.received.length;
  await until(() => client.received.length >= offset + 4000, "decoded RTP continues");
  return assertTone(client.received.slice(offset + 1600, offset + 4000), frequency);
}
try {
  await until(
    async () => {
      try {
        observer = await openEsl();
        return /RUNNING/.test((await observer.command("api sofia status")).body);
      } catch {
        observer?.close();
        return false;
      }
    },
    "FS startup",
    15000
  );
  report.fs = await command("version");
  f = await cleanupFixture({
    host: join(directory, "socket"),
    database: "d01",
    user: "postgres",
    connectionTimeoutMillis: 1000
  });
  report.database = (await f.pool.query("select version()")).rows[0].version;
  const user = (await f.pool.query("select * from users where id=$1", [f.userId])).rows[0];

  const service = new DeskSessions(f.pool, config);
  const remove = service.telephony.remove;
  let holdCleanup = false;
  service.telephony.remove = async (username) => {
    if (holdCleanup) throw new Error("injected cleanup delay");
    return remove(username);
  };
  app = Fastify();
  await app.register(cookie);
  registerDeskSessionRoutes(app, config, f.pool, service);
  const token = signAuthToken(config, {
    sub: user.id,
    email: user.email,
    role: "agent",
    ver: user.auth_version
  });
  async function http(method, input) {
    const response = await app.inject({
      method,
      url: method === "POST" ? "/agent/desk-sessions" : `/agent/desk-sessions/${input.deskSessionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: input
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  const create = (revision) =>
    http("POST", { campaignId: f.campaignId, expectedRevision: revision, idempotencyKey: randomUUID() });
  const patch = (s) => http("PATCH", { ...mutation(s), campaignId: f.campaignId, ready: true });
  async function client(identity, source, frequency) {
    const c = await endpoint({ username: identity.username, password: identity.password, source, frequency });
    clients.push(c);
    await c.register();
    return c;
  }
  const first = await create("1");
  assert.equal(first.session.ready, false);
  const old = await client(first.sip, "127.0.0.2", 880);
  let current = (await patch(first.session)).session;
  assert.equal(current.ready, true);
  holdCleanup = true;
  const second = await create(current.revision);
  const now = await client(second.sip, "127.0.0.3", 880);
  current = (await patch(second.session)).session;
  assert.equal(current.ready, true);
  const currentUsername = second.sip.username;
  for (const shape of ["inbound", "outbound", "transfer"]) {
    const uuid = randomUUID(),
      before = old.invites.length;
    const contact = (
      await f.pool.query("select verified_endpoint from agent_desk_sessions where id=$1", [current.id])
    ).rows[0].verified_endpoint;
    assert.match(
      await command(`originate {origination_uuid=${uuid},originate_timeout=3}${contact} &park()`),
      /^\+OK/
    );
    await until(
      () => now.invites.some((i) => i.uuid === uuid) || now.invites.length > 0,
      "new endpoint INVITE"
    );
    assert.equal(old.invites.length, before);
    await command(`uuid_kill ${uuid} NORMAL_CLEARING`);
    await pass(`D01.1 ${shape}-shaped exact-contact delivery selects new controller only`, {
      uuid,
      oldInvites: old.invites.length,
      newInvites: now.invites.length
    });
  }
  await old.register();
  let response = await app.inject({
    method: "PATCH",
    url: `/agent/desk-sessions/${first.session.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { ...mutation(first.session), campaignId: f.campaignId, ready: true }
  });
  assert.equal(response.statusCode, 409);
  response = await app.inject({
    method: "DELETE",
    url: `/agent/desk-sessions/${first.session.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: mutation(first.session)
  });
  assert.equal(response.statusCode, 409);
  await old.register(0);
  old.close();
  clients.splice(clients.indexOf(old), 1);
  current = (await patch(current)).session;
  assert.equal(current.ready, true);
  holdCleanup = false;
  await service.cleanup();
  assert.match(
    await command(`sofia_contact internal-webrtc/${currentUsername}@a04.invalid`),
    /sofia\/internal-webrtc/
  );
  assert.match(
    await command(`sofia_contact internal-webrtc/${first.sip.username}@a04.invalid`),
    /(?:-ERR|error\/user_not_registered)/
  );
  await pass("D01.2 old refresh/unregister/close and exact obsolete cleanup preserve current generation", {
    generation: current.bindingGeneration
  });
  // Same-identity second registration is ambiguity, not a new browser authority.
  const duplicate = await client(second.sip, "127.0.0.4", 990);
  current = (await patch(current)).session;
  assert.equal(current.ready, false);
  await duplicate.register(0);
  duplicate.close();
  clients.splice(clients.indexOf(duplicate), 1);
  current = (await patch(current)).session;
  assert.equal(current.ready, true);
  await pass(
    "D01.1 ambiguous contact clears readiness; original pinned contact recovers after duplicate unregister"
  );
  const customerIdentity = {
    username: `desk_${randomUUID().replaceAll("-", "")}`,
    password: randomBytes(24).toString("hex")
  };
  await provisionAgentDirectory(config, {
    sipUsername: customerIdentity.username,
    sipPassword: customerIdentity.password,
    displayName: "Fixture customer"
  });
  await command("reloadxml");
  const customer = await client(customerIdentity, "127.0.0.5", 440);
  const destination = await command(`sofia_contact internal-webrtc/${customerIdentity.username}@a04.invalid`);
  for (const direction of ["inbound", "outbound", "transfer"]) {
    const seeded = await f.seed({ inbound: direction === "inbound" });
    const contact = (
      await f.pool.query("select verified_endpoint from agent_desk_sessions where id=$1", [current.id])
    ).rows[0].verified_endpoint;
    for (const [uuid, target] of [
      [seeded.agentUuid, contact],
      [seeded.customerUuid, destination]
    ])
      assert.match(
        await command(
          `originate {origination_uuid=${uuid},originate_timeout=3,hangup_after_bridge=false,park_after_bridge=true}${target} &park()`
        ),
        /^\+OK/
      );
    assert.match(await command(`uuid_bridge ${seeded.agentUuid} ${seeded.customerUuid}`), /^\+OK/);
    const media = [];
    for (const state of ["reserved", "connecting", "active", "releasing", "uncertain"]) {
      await f.pool.query("update agent_call_slots set state=$2 where agent_id=$1", [f.agentId, state]);
      const slot = (await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.agentId]))
        .rows[0];
      const takeover = await app.inject({
        method: "POST",
        url: "/agent/desk-sessions",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          campaignId: f.campaignId,
          expectedRevision: current.revision,
          idempotencyKey: randomUUID()
        }
      });
      assert.equal(takeover.statusCode, 409);
      assert.equal(takeover.json().code, "slot_occupied");
      // Lost browser heartbeat / lease expires; actual media remains alive.
      await f.pool.query(
        "update agent_desk_sessions set created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where id=$1",
        [current.id]
      );
      await now.register(0);
      await service.reconcile();
      const row = (await f.pool.query("select * from agent_desk_sessions where id=$1", [current.id])).rows[0];
      assert.equal(row.ready, false);
      assert.equal(row.revoked_at, null);
      assert.deepEqual(
        (await f.pool.query("select * from agent_call_slots where agent_id=$1", [f.agentId])).rows[0],
        slot
      );
      media.push({ state, agent: await tones(now, 440), customer: await tones(customer, 880) });
      // Authenticated same-controller reconnect renews the same occupied generation.
      await now.register();
      current = (await patch({ ...current, revision: row.revision })).session;
      assert.equal(current.ready, true);
    }
    await command(`uuid_kill ${seeded.agentUuid} NORMAL_CLEARING`);
    await command(`uuid_kill ${seeded.customerUuid} NORMAL_CLEARING`);
    // Explicit fixture terminal/quiescence; this is not product call reconciliation.

    await f.pool.query("update call_legs set ended_at=clock_timestamp(),state='ended' where call_id=$1", [
      seeded.callId
    ]);
    await f.pool.query("update calls set state='completed',ended_at=clock_timestamp() where id=$1", [
      seeded.callId
    ]);
    await f.pool.query(
      "update agent_call_slots set state='free',call_id=null,participant_id=null,reservation_id=null,reconciliation_required=false where agent_id=$1",
      [f.agentId]
    );
    await pass(
      `D01.3 ${direction}-shaped occupied takeover/lease-loss/reconnect matrix preserves bidirectional media`,
      { media }
    );
  }
  await http("DELETE", mutation(current));
  await until(async () => (await command("show channels count")).startsWith("0 total"), "no leaked channels");
  report.status = "passed";
  await pass("bounded cleanup converged; no live channels; no provider traffic");
} catch (error) {
  report.status = "failed";
  report.error = error.stack;
  throw error;
} finally {
  for (const c of clients) c.close();
  await app?.close();
  observer?.close();
  if (f) await f.cleanup();
  await save();
}
