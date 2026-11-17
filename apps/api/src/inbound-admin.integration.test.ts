import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import type {
  InboundFlowSnapshot,
  InboundQueueSnapshot,
  InboundNumberSnapshot
} from "@outbound-dialer/shared";
import { databaseConfig, testDatabaseUrl, assertBlocked } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import type { AppConfig } from "./config.js";
import { registerInboundAdminRoutes } from "./dashboard/inbound-admin.js";
import { registerAdminAudit } from "./admin-audit.js";
import { registerCookieCsrfProtection } from "./security.js";
import { signAuthToken } from "./auth/tokens.js";
import { validationErrorResponse } from "./validation.js";
import { InboundAdminError, mutateInboundConfiguration } from "./inbound-admin.js";
import { saveInboundFlowSchema } from "./call-coordination-contracts.js";
import {
  InboundConfigurationPublisher,
  atomicConfigurationWrite,
  deniedInboundXml
} from "./freeswitch/inbound-config.js";
import { importIngressRecord } from "./inbound-ingress.js";
import { deleteRecording } from "./dashboard/recordings.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
const key = () => ({ idempotencyKey: randomUUID(), expectedRevision: null });
const wait = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture() {
  const schema = `f01_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool({ ...databaseConfig(testDatabaseUrl(), schema), max: 10 });
  await runMigrations(pool);
  const users = (
    await pool.query(`insert into users(email,name,password_hash,role) values
    ('f01-admin@test','F01','fixture','admin'),('f01-agent@test','F01 agent','fixture','agent') returning *`)
  ).rows;
  const owner = users.find((u) => u.role === "admin")!;
  const campaign = (
    await pool.query("insert into campaigns(name,status) values('F01','active') returning id")
  ).rows[0].id as string;
  const other = (await pool.query("insert into campaigns(name,status) values('Other','active') returning id"))
    .rows[0].id as string;
  const audios: string[] = [];
  for (const c of [campaign, other])
    audios.push(
      (
        await pool.query(
          `insert into recordings(name,campaign_id,file_path,runtime_file_path,duration_seconds)
    values('F01',$1,'/fixture/f01.wav','/runtime/f01.wav',10) returning id`,
          [c]
        )
      ).rows[0].id
    );
  const directory = await mkdtemp("/tmp/f01-config-");
  const config = {
    JWT_SECRET: "f01-isolated-fixture-secret",
    JWT_EXPIRES_SECONDS: 3600,
    PUBLIC_APP_URL: "https://f01.test",
    corsOrigins: [],
    FREESWITCH_ESL_ENABLED: true,
    FREESWITCH_INBOUND_CONFIG_ENABLED: true,
    FREESWITCH_GENERATED_CONFIG_DIR: directory,
    FREESWITCH_INBOUND_TRUSTED_CIDRS: "127.0.0.2/32",
    FREESWITCH_INBOUND_PRE_ADMISSION_LIMIT: 8,
    FREESWITCH_TRUNK_CHANNEL_LIMIT: 40,
    FREESWITCH_INBOUND_WAIT_SECONDS: 3
  } as unknown as AppConfig;
  const app = Fastify();
  await app.register(cookie);
  registerCookieCsrfProtection(app, config);
  registerAdminAudit(app, config, pool);
  app.setErrorHandler((error, _req, reply) =>
    error instanceof ZodError ? reply.code(400).send(validationErrorResponse(error)) : reply.send(error)
  );
  registerInboundAdminRoutes(app, config, pool);
  const tokens = users.map((u) => ({
    role: u.role,
    token: signAuthToken(config, { sub: u.id, email: u.email, role: u.role, ver: u.auth_version })
  }));
  const token = tokens.find((t) => t.role === "admin")!.token;
  const agentToken = tokens.find((t) => t.role === "agent")!.token;
  const request = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    resource: string,
    payload?: object,
    headers: Record<string, string> = { authorization: `Bearer ${token}` }
  ) => app.inject({ method, url: `/admin/inbound-${resource}`, payload, headers });
  const save = async <T>(
    method: "POST" | "PATCH" | "DELETE",
    resource: string,
    payload: object
  ): Promise<T> => {
    const r = await request(method, resource, payload);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const flowInput = (actions: object[] = [{ type: "hangup" }]) => ({
    ...key(),
    campaignId: campaign,
    name: "F01",
    definition: { flowTimeoutMs: 90000, actions }
  });
  const flow = (actions?: object[]) => save<InboundFlowSnapshot>("POST", "flows", flowInput(actions));
  const queueInput = (version: string | null = null) => ({
    ...key(),
    campaignId: campaign,
    name: "Shared",
    waitingRecordingId: audios[0],
    noAnswerFlowVersionId: version,
    configuration: {}
  });
  const queue = (version?: string) => save<InboundQueueSnapshot>("POST", "queues", queueInput(version));
  const numberInput = (queueId: string, did = " +1 (415) 555-0100 ") => ({
    ...key(),
    label: "F01",
    did,
    queueId,
    enabled: false
  });
  const actor = { id: owner.id, authVersion: owner.auth_version, requestId: "f01-test" };
  const ledger = async () =>
    (await pool.query("select * from inbound_configuration_mutations order by created_at,idempotency_key"))
      .rows;
  const state = async () => {
    const counts = (
      await pool.query(`select
      (select count(*) from calls)::int as calls,(select count(*) from call_operations)::int as operations,
      (select count(*) from call_offers)::int as offers,(select count(*) from agent_call_slots)::int as slots,
      (select count(*) from call_capacity_reservations)::int as capacity,
      (select coalesce(sum(attempt_count),0) from contacts)::int as attempts`)
    ).rows[0];
    return {
      counts,
      numbers: (await pool.query("select * from inbound_numbers order by id")).rows,
      queues: (await pool.query("select * from inbound_queues order by id")).rows,
      flows: (await pool.query("select * from inbound_flows order by id")).rows,
      versions: (await pool.query("select * from inbound_flow_versions order by id")).rows,
      fs: (await pool.query("select * from inbound_freeswitch_configuration")).rows,
      ledger: await ledger()
    };
  };
  const commands: string[] = [];
  const active = join(directory, "dialplan/public/00-inbound.xml");
  await atomicConfigurationWrite(active, deniedInboundXml);
  let loaded = deniedInboundXml;
  let fail = false;
  const publisher = new InboundConfigurationPublisher(pool, config, {
    command: async (cmd) => {
      commands.push(cmd);
      if (cmd === "reloadxml") {
        if (fail) {
          fail = false;
          return "-ERR fixture reload failure";
        }
        loaded = await readFile(active, "utf8");
        return "+OK";
      }
      return loaded;
    }
  });
  return {
    schema,
    pool,
    app,
    config,
    campaign,
    other,
    audio: audios[0]!,
    otherAudio: audios[1]!,
    actor,
    token,
    agentToken,
    request,
    save,
    flowInput,
    flow,
    queueInput,
    queue,
    numberInput,
    state,
    ledger,
    commands,
    publisher,
    active,
    loaded: () => loaded,
    failReload: () => {
      fail = true;
    },
    async cleanup() {
      await app.close();
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test(
  "F01.1 DB/API: multi-DID CRUD, audio/forward/combined flows, normalized targets and persistent replay",
  options,
  async () => {
    const f = await fixture();
    try {
      const audio = { type: "play_audio", recordingId: f.audio, timeoutMs: 10000 };
      const forward = { type: "forward_external", target: "0014155550199", timeoutMs: 20000 };
      const a = await f.flow([audio, { type: "hangup" }]);
      const b = await f.flow([forward]);
      const c = await f.flow([audio, forward, audio]);
      assert.equal(
        b.definition.actions[0].type === "forward_external" && b.definition.actions[0].target,
        "+14155550199"
      );
      const q = await f.queue(c.versionId);
      const nInput = f.numberInput(q.id);
      const n = await f.save<InboundNumberSnapshot>("POST", "numbers", nInput);
      const replay = await f.save<InboundNumberSnapshot>("POST", "numbers", {
        ...nInput,
        did: "0014155550100"
      });
      assert.deepEqual(replay, n, "normalization precedes fingerprinting");
      await f.save("POST", "numbers", f.numberInput(q.id, "+14155550101"));
      assert.equal(n.did, "+14155550100");
      assert.equal(n.apply.status, "pending");
      assert.equal((await f.request("GET", "numbers")).json().items.length, 2);
      assert.equal((await f.request("GET", "queues")).json().items.length, 1);
      assert.equal((await f.request("GET", "flows")).json().items.length, 3);
      assert.equal(
        (await f.request("POST", "numbers", { ...nInput, label: "different" })).json().code,
        "idempotency_conflict"
      );
      assert.equal(
        (await f.request("POST", "numbers", { ...nInput, ...key() })).json().code,
        "duplicate_configuration"
      );
      const q2 = await f.save<InboundQueueSnapshot>("PATCH", `queues/${q.id}`, {
        ...f.queueInput(a.versionId),
        expectedRevision: q.revision,
        configuration: { overflowPolicy: "flow", overflowFlowVersionId: b.versionId, maxWaitingCalls: 1 }
      });
      assert.equal(q2.configuration.maxWaitingCalls, 1);
      assert.equal(q2.configuration.overflowFlowVersionId, b.versionId);
      assert.equal(
        (await f.request("POST", "flows", f.flowInput([{ ...forward, target: n.did }]))).json().code,
        "owned_did_forwarding_loop"
      );
      assert.equal(
        (await f.request("POST", "numbers", f.numberInput(q.id, "+14155550199"))).json().code,
        "owned_did_forwarding_loop",
        "reverse edit order also rejects loops"
      );
      assert.equal((await f.state()).counts.calls, 0);
      assert.equal(f.commands.length, 0, "configuration saves send no ESL/media commands");
      await f.save("DELETE", `numbers/${n.id}`, { ...key(), expectedRevision: n.revision });
      const del = { ...key(), expectedRevision: "1" };
      await f.save("DELETE", `flows/${c.id}`, del);
      await f.save("DELETE", `flows/${c.id}`, del);
      assert.equal((await f.request("GET", "flows")).json().items.length, 2);
      assert.equal(
        (await f.pool.query("select 1 from inbound_flow_versions where id=$1", [c.versionId])).rowCount,
        1
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "F01.1–F01.2 DB/API: bounded validators, missing/foreign/inactive references, auth and CSRF reject without configuration mutations",
  options,
  async () => {
    const f = await fixture();
    try {
      const baseline = await f.state();
      const audio = { type: "play_audio", recordingId: f.audio, timeoutMs: 10000 };
      const forward = { type: "forward_external", target: "+14155550199", timeoutMs: 20000 };
      for (const actions of [
        [],
        [{ type: "jump", flowId: randomUUID() }],
        [{ type: "hangup" }, audio],
        [forward, forward],
        [audio, audio, audio],
        [audio, forward, audio, { type: "hangup" }],
        [{ ...forward, target: "+123" }],
        [{ ...forward, target: "sip:a@test" }],
        [{ ...forward, timeoutMs: 30001 }],
        [{ ...forward, target: undefined }],
        [{ ...audio, recordingId: undefined }],
        [{ ...audio, timeoutMs: 999 }],
        [{ ...audio, nextFlowId: randomUUID() }]
      ]) {
        const r = await f.request("POST", "flows", f.flowInput(actions));
        assert.equal(r.statusCode, 400, r.body);
      }
      assert.equal(
        (
          await f.request("POST", "flows", {
            ...f.flowInput([audio, forward]),
            definition: { actions: [audio, forward], flowTimeoutMs: 29999 }
          })
        ).statusCode,
        400
      );
      for (const recordingId of [f.otherAudio, randomUUID()]) {
        const r = await f.request("POST", "flows", f.flowInput([{ ...audio, recordingId }]));
        assert.equal(r.statusCode, 409, r.body);
        assert.equal(r.json().code, "audio_unavailable");
      }
      assert.equal(
        (await f.request("POST", "flows", f.flowInput([{ ...audio, timeoutMs: 5000 }]))).json().code,
        "audio_unavailable",
        "full asset fits playback budget"
      );
      for (const overrides of [
        { waitingRecordingId: f.otherAudio },
        { noAnswerFlowVersionId: randomUUID() },
        { configuration: { overflowPolicy: "flow" } },
        { configuration: { overflowPolicy: "reject", overflowFlowVersionId: randomUUID() } },
        { configuration: { connectTimeoutMs: 15000, queueTimeoutMs: 15000 } },
        { configuration: { maxWaitingCalls: 201 } },
        { campaignId: randomUUID() }
      ])
        assert.ok(
          [400, 409].includes(
            (await f.request("POST", "queues", { ...f.queueInput(), ...overrides })).statusCode
          )
        );
      for (const resource of ["flows", "queues", "numbers"]) {
        const input =
          resource === "flows"
            ? f.flowInput()
            : resource === "queues"
              ? f.queueInput()
              : f.numberInput(randomUUID());
        for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
          const path = resource + (method === "PATCH" || method === "DELETE" ? `/${randomUUID()}` : "");
          assert.equal(
            (await f.request(method, path, method === "GET" ? undefined : input, {})).statusCode,
            401
          );
          assert.equal(
            (
              await f.request(method, path, method === "GET" ? undefined : input, {
                authorization: `Bearer ${f.agentToken}`
              })
            ).statusCode,
            403
          );
          if (method !== "GET")
            for (const origin of [undefined, "https://foreign.test"]) {
              const r = await f.request(method, path, input, {
                cookie: `outbound_dialer_session=${f.token}`,
                ...(origin ? { origin } : {})
              });
              assert.equal(r.statusCode, 403, r.body);
            }
        }
      }
      for (const did of ["+123", "+999123456789", "4155550100", "sip:agent@test"])
        assert.equal((await f.request("POST", "numbers", f.numberInput(randomUUID(), did))).statusCode, 400);
      assert.equal(
        (await f.request("POST", "numbers", f.numberInput(randomUUID()))).json().code,
        "queue_unavailable"
      );
      assert.equal(
        (await f.request("POST", "flows", { ...f.flowInput(), dialTarget: "+14155550198" })).statusCode,
        400
      );
      assert.deepEqual(await f.state(), baseline);
      assert.equal(f.commands.length, 0);
      // An allowed same-origin cookie mutation uses the same role/validation path.
      assert.equal(
        (
          await f.request("POST", "flows", f.flowInput(), {
            cookie: `outbound_dialer_session=${f.token}`,
            origin: "https://f01.test"
          })
        ).statusCode,
        200
      );
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "F01.3 DB/API: immutable v1 survives v2/queue edits, referenced disable/delete, applied/error state and atomic audit",
  options,
  async () => {
    const f = await fixture();
    try {
      const v1 = await f.flow([
        { type: "play_audio", recordingId: f.audio, timeoutMs: 10000 },
        { type: "hangup" }
      ]);
      const q = await f.queue(v1.versionId);
      const n = await f.save<InboundNumberSnapshot>("POST", "numbers", {
        ...f.numberInput(q.id),
        enabled: true
      });
      const queueRow = (await f.pool.query("select * from inbound_queues where id=$1", [q.id])).rows[0];
      const row = {
        uuid: randomUUID(),
        journalId: randomUUID(),
        sequence: 1,
        arrivedUs: Date.now() * 1000,
        did: n.did,
        routeRevision: n.revision,
        numberId: n.id,
        queueId: q.id,
        queueRevision: q.revision,
        campaignId: f.campaign,
        timeoutMs: 60000,
        routeData: Buffer.from(JSON.stringify(queueRow)).toString("base64url"),
        callingNumber: "unknown",
        terminalUs: null,
        terminalReason: null
      };
      await importIngressRecord(f.pool, row);
      const evidence = (await f.pool.query("select * from inbound_ingress_evidence")).rows;
      const call = (await f.pool.query("select * from calls")).rows;
      const versions = (await f.pool.query("select * from inbound_flow_versions where id=$1", [v1.versionId]))
        .rows;
      const v2 = await f.save<InboundFlowSnapshot>("PATCH", `flows/${v1.id}`, {
        ...f.flowInput(),
        expectedRevision: v1.revision
      });
      assert.equal(v2.revision, "2");
      assert.notEqual(v2.versionId, v1.versionId);
      for (const method of ["PATCH", "DELETE"] as const) {
        const r = await f.request(method, `flows/${v1.id}`, {
          ...(method === "PATCH" ? { ...f.flowInput(), enabled: false } : key()),
          expectedRevision: v2.revision
        });
        assert.equal(r.statusCode, 409, r.body);
        assert.equal(r.json().code, "configuration_in_use");
      }
      assert.equal(
        (await f.request("DELETE", `queues/${q.id}`, { ...key(), expectedRevision: q.revision })).json().code,
        "configuration_in_use"
      );
      assert.equal(
        (await f.request("DELETE", `numbers/${n.id}`, { ...key(), expectedRevision: n.revision })).json()
          .code,
        "disable_before_delete"
      );
      assert.deepEqual(
        (await f.pool.query("select * from inbound_flow_versions where id=$1", [v1.versionId])).rows,
        versions
      );
      await assert.rejects(
        f.pool.query("update inbound_flow_versions set actions='[]' where id=$1", [v1.versionId]),
        /immutable/
      );
      await assert.rejects(
        f.pool.query("delete from inbound_flow_versions where id=$1", [v1.versionId]),
        /immutable/
      );
      assert.equal(await f.publisher.reconcile(), "applied");
      assert.equal((await f.request("GET", "numbers")).json().items[0].apply.status, "applied");
      const loaded = f.loaded();
      const updated = await f.save<InboundQueueSnapshot>("PATCH", `queues/${q.id}`, {
        ...f.queueInput(v2.versionId),
        expectedRevision: q.revision,
        configuration: { queueTimeoutMs: 90000 }
      });
      assert.equal(updated.apply.status, "pending");
      f.failReload();
      assert.equal(await f.publisher.reconcile(), "error");
      const failed = (await f.request("GET", "queues")).json().items[0];
      assert.equal(failed.apply.status, "error");
      assert.match(failed.apply.error, /reloadxml failed/);
      assert.equal(failed.apply.appliedRevision, q.revision);
      assert.equal(f.loaded(), loaded);
      assert.equal(await f.publisher.reconcile(), "applied");
      assert.equal((await f.request("GET", "queues")).json().items[0].apply.status, "applied");
      assert.deepEqual((await f.pool.query("select * from inbound_ingress_evidence")).rows, evidence);
      assert.deepEqual((await f.pool.query("select * from calls")).rows, call);
      assert.deepEqual(
        (await f.pool.query("select * from inbound_flow_versions where id=$1", [v1.versionId])).rows,
        versions
      );
      assert.equal((await deleteRecording(f.pool, f.audio)).status, "in_use");
      const counts = (await f.state()).counts;
      assert.equal(counts.calls, 1);
      for (const k of ["operations", "offers", "slots", "capacity", "attempts"]) assert.equal(counts[k], 0);
      const ledger = await f.ledger();
      assert.ok(
        ledger.every((r) => r.actor_user_id === f.actor.id && r.request_id && r.resource_id && r.revision)
      );
      const audits = (await f.pool.query("select * from admin_audit_events where status_code=200")).rows;
      assert.ok(audits.length >= 5);
      assert.ok(audits.every((r) => r.actor_user_id === f.actor.id));
      if (process.env.INBOUND_TEST_ARTIFACTS)
        await writeFile(
          join(process.env.INBOUND_TEST_ARTIFACTS, "f01-report.json"),
          JSON.stringify(
            {
              proof: "real PostgreSQL + HTTP, simulated FS application only",
              base: "62413ee98622798450fa55972c6c2fe278de91b0",
              v1,
              v2,
              updated,
              failed,
              counts,
              commands: f.commands,
              ledger
            },
            null,
            2
          )
        );
    } finally {
      await f.cleanup();
    }
  }
);

for (const rollback of [false, true])
  for (const reverse of [false, true])
    test(
      `F01.3 DB: independent concurrent edits revalidate after lock, reverse=${reverse}, rollback=${rollback}`,
      options,
      async () => {
        const f = await fixture();
        const held = wait(),
          resume = wait();
        let pending: Promise<unknown> | undefined;
        try {
          const flow = await f.flow();
          const a = saveInboundFlowSchema.parse({
            ...f.flowInput(),
            name: reverse ? "B" : "A",
            expectedRevision: flow.revision
          });
          const b = saveInboundFlowSchema.parse({
            ...f.flowInput(),
            name: reverse ? "A" : "B",
            expectedRevision: flow.revision
          });
          let firstPid = 0,
            secondPid = 0;
          const first = await f.pool.connect(),
            second = await f.pool.connect();
          firstPid = (await first.query("select pg_backend_pid() as p")).rows[0].p;
          secondPid = (await second.query("select pg_backend_pid() as p")).rows[0].p;
          const one = mutateInboundConfiguration(
            { connect: async () => first } as unknown as pg.Pool,
            f.actor,
            "flows",
            "PATCH",
            flow.id,
            a,
            async () => {
              held.resolve();
              await resume.promise;
              if (rollback) throw new Error("controlled rollback");
            }
          ).then(
            (value) => ({ value }),
            (error) => ({ error })
          );
          await held.promise;
          pending = mutateInboundConfiguration(
            { connect: async () => second } as unknown as pg.Pool,
            f.actor,
            "flows",
            "PATCH",
            flow.id,
            b
          );
          void pending.catch(() => {});
          await assertBlocked(f.pool, secondPid, firstPid);
          const before = await f.ledger();
          assert.equal(before.length, 1, "uncommitted edit/audit is invisible");
          resume.resolve();
          const firstResult = await one;
          if (rollback) {
            assert.ok("error" in firstResult);
            assert.equal(((await pending) as InboundFlowSnapshot).name, b.name);
          } else {
            assert.ok("value" in firstResult);
            await assert.rejects(
              pending,
              (e) => e instanceof InboundAdminError && e.code === "revision_conflict"
            );
          }
          assert.equal(
            (await f.pool.query("select count(*)::int as n from inbound_flow_versions")).rows[0].n,
            2
          );
          assert.equal((await f.ledger()).length, 2);
          assert.equal(f.commands.length, 0);
        } finally {
          resume.resolve();
          await pending?.catch(() => {});
          await f.cleanup();
        }
      }
    );

test(
  "F01.3 DB: publisher lock, post-lock access revocation, rejected snapshot rollback and concurrent replay",
  options,
  async () => {
    const f = await fixture();
    try {
      const holder = await f.pool.connect(),
        waiter = await f.pool.connect();
      const firstPid = (await holder.query("select pg_backend_pid() as p")).rows[0].p;
      const secondPid = (await waiter.query("select pg_backend_pid() as p")).rows[0].p;
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(72204,0)");
      const input = saveInboundFlowSchema.parse(f.flowInput());
      const pending = mutateInboundConfiguration(
        { connect: async () => waiter } as unknown as pg.Pool,
        f.actor,
        "flows",
        "POST",
        null,
        input
      );
      await assertBlocked(f.pool, secondPid, firstPid);
      await holder.query("update users set auth_version=auth_version+1 where id=$1", [f.actor.id]);
      await holder.query("commit");
      holder.release();
      await assert.rejects(pending, (e) => e instanceof InboundAdminError && e.status === 403);
      assert.equal((await f.ledger()).length, 0);
      assert.equal((await f.pool.query("select * from inbound_flows")).rowCount, 0);
      await f.pool.query("update users set auth_version=1 where id=$1", [f.actor.id]);
      await assert.rejects(
        mutateInboundConfiguration(f.pool, f.actor, "flows", "POST", null, input, async () => {
          throw new Error("rollback all");
        }),
        /rollback all/
      );
      assert.equal((await f.ledger()).length, 0);
      assert.equal((await f.pool.query("select * from inbound_flows")).rowCount, 0);
      const held = wait(),
        resume = wait();
      const a = await f.pool.connect(),
        b = await f.pool.connect();
      const ap = (await a.query("select pg_backend_pid() as p")).rows[0].p,
        bp = (await b.query("select pg_backend_pid() as p")).rows[0].p;
      const one = mutateInboundConfiguration(
        { connect: async () => a } as unknown as pg.Pool,
        f.actor,
        "flows",
        "POST",
        null,
        input,
        async () => {
          held.resolve();
          await resume.promise;
        }
      );
      await held.promise;
      const two = mutateInboundConfiguration(
        { connect: async () => b } as unknown as pg.Pool,
        f.actor,
        "flows",
        "POST",
        null,
        input
      );
      await assertBlocked(f.pool, bp, ap);
      resume.resolve();
      assert.deepEqual(await one, await two);
      assert.equal((await f.ledger()).length, 1);
      assert.equal((await f.pool.query("select * from inbound_flow_versions")).rowCount, 1);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "F01.1–F01.3 DB/API: inactive assets, foreign/disabled flows, configuration lifecycle and revision-safe deletion",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.pool.query("update recordings set is_active=false where id=$1", [f.audio]);
      const before = await f.state();
      assert.equal(
        (
          await f.request(
            "POST",
            "flows",
            f.flowInput([{ type: "play_audio", recordingId: f.audio, timeoutMs: 10000 }])
          )
        ).json().code,
        "audio_unavailable"
      );
      assert.equal((await f.request("POST", "queues", f.queueInput())).json().code, "audio_unavailable");
      assert.deepEqual(await f.state(), before);
      await f.pool.query("update recordings set is_active=true where id=$1", [f.audio]);
      const foreign = await f.save<InboundFlowSnapshot>("POST", "flows", {
        ...f.flowInput(),
        campaignId: f.other
      });
      assert.equal(
        (await f.request("POST", "queues", f.queueInput(foreign.versionId))).json().code,
        "flow_unavailable"
      );
      const flow = await f.flow();
      const disabled = await f.save<InboundFlowSnapshot>("PATCH", `flows/${flow.id}`, {
        ...f.flowInput(),
        enabled: false,
        expectedRevision: flow.revision
      });
      assert.equal(disabled.enabled, false);
      const baseline = await f.state();
      assert.equal(
        (await f.request("POST", "queues", f.queueInput(disabled.versionId))).json().code,
        "flow_unavailable"
      );
      assert.equal(
        (
          await f.request("PATCH", `flows/${flow.id}`, { ...f.flowInput(), expectedRevision: flow.revision })
        ).json().code,
        "revision_conflict"
      );
      assert.equal(
        (
          await f.request("PATCH", `flows/${flow.id}`, {
            ...f.flowInput(),
            campaignId: f.other,
            expectedRevision: disabled.revision
          })
        ).json().code,
        "campaign_immutable"
      );
      assert.deepEqual(await f.state(), baseline);
      const q = await f.queue();
      const n = await f.save<InboundNumberSnapshot>("POST", "numbers", f.numberInput(q.id));
      for (const [resource, snapshot, input] of [
        ["numbers", n, f.numberInput(q.id)],
        ["queues", q, f.queueInput()]
      ] as const) {
        const old = await f.state();
        assert.equal(
          (
            await f.request("PATCH", `${resource}/${snapshot.id}`, { ...input, expectedRevision: "999" })
          ).json().code,
          "revision_conflict"
        );
        assert.equal(
          (
            await f.request("DELETE", `${resource}/${snapshot.id}`, { ...key(), expectedRevision: "999" })
          ).json().code,
          "revision_conflict"
        );
        assert.deepEqual(await f.state(), old);
      }
      const updated = await f.save<InboundNumberSnapshot>("PATCH", `numbers/${n.id}`, {
        ...f.numberInput(q.id),
        label: "Edited",
        enabled: true,
        expectedRevision: n.revision
      });
      assert.equal(updated.revision, "2");
      const off = await f.save<InboundNumberSnapshot>("PATCH", `numbers/${n.id}`, {
        ...f.numberInput(q.id),
        label: "Edited",
        enabled: false,
        expectedRevision: updated.revision
      });
      await f.save("DELETE", `numbers/${n.id}`, { ...key(), expectedRevision: off.revision });
      const deletion = { ...key(), expectedRevision: q.revision };
      assert.deepEqual(await f.save("DELETE", `queues/${q.id}`, deletion), { ok: true });
      assert.deepEqual(await f.save("DELETE", `queues/${q.id}`, deletion), { ok: true });
      assert.equal(
        (await f.request("PATCH", `queues/${q.id}`, { ...f.queueInput(), expectedRevision: q.revision }))
          .statusCode,
        404
      );
      await f.save("DELETE", `flows/${flow.id}`, { ...key(), expectedRevision: disabled.revision });
      assert.equal(
        (await f.pool.query("select * from inbound_flow_versions where flow_id=$1", [flow.id])).rowCount,
        2
      );
      assert.equal(f.commands.length, 0);
    } finally {
      await f.cleanup();
    }
  }
);

test(
  "F01 migration 040 upgrades populated 039, preserves configuration/history and replays checksums",
  options,
  async () => {
    const f = await fixture();
    try {
      const flow = await f.flow();
      await f.queue(flow.versionId);
      const version = (await f.pool.query("select * from inbound_flow_versions")).rows;
      const queues = (await f.pool.query("select * from inbound_queues")).rows;
      const history = (
        await f.pool.query("select * from schema_migrations where filename<'040' order by filename")
      ).rows;
      await f.pool
        .query(`drop table inbound_configuration_mutations;alter table inbound_flows drop column enabled,drop column deleted_at;
      delete from schema_migrations where filename='040_inbound_admin_configuration.sql'`);
      await runMigrations(f.pool);
      await runMigrations(f.pool);
      assert.deepEqual((await f.pool.query("select * from inbound_flow_versions")).rows, version);
      assert.deepEqual((await f.pool.query("select * from inbound_queues")).rows, queues);
      assert.deepEqual(
        (await f.pool.query("select * from schema_migrations where filename<'040' order by filename")).rows,
        history
      );
      assert.equal((await f.pool.query("select * from inbound_flows")).rows[0].enabled, true);
      assert.equal((await f.pool.query("select * from inbound_numbers where enabled")).rowCount, 0);
    } finally {
      await f.cleanup();
    }
  }
);

for (const firstResource of ["numbers", "flows"] as const)
  test(
    `F01.1 DB: owned-DID loop checks revalidate after competing ${firstResource} creation commits`,
    options,
    async () => {
      const f = await fixture();
      const held = wait(),
        resume = wait();
      let pending: Promise<unknown> | undefined, one: Promise<unknown> | undefined;
      try {
        const q = await f.queue();
        const { saveInboundNumberSchema } = await import("./call-coordination-contracts.js");
        const number = saveInboundNumberSchema.parse(f.numberInput(q.id, "+14155550198"));
        const flow = saveInboundFlowSchema.parse(
          f.flowInput([{ type: "forward_external", target: "+14155550198", timeoutMs: 10000 }])
        );
        const a = await f.pool.connect(),
          b = await f.pool.connect();
        const ap = (await a.query("select pg_backend_pid() as p")).rows[0].p,
          bp = (await b.query("select pg_backend_pid() as p")).rows[0].p;
        one = mutateInboundConfiguration(
          { connect: async () => a } as unknown as pg.Pool,
          f.actor,
          firstResource,
          "POST",
          null,
          firstResource === "numbers" ? number : flow,
          async () => {
            held.resolve();
            await resume.promise;
          }
        );
        await held.promise;
        pending = mutateInboundConfiguration(
          { connect: async () => b } as unknown as pg.Pool,
          f.actor,
          firstResource === "numbers" ? "flows" : "numbers",
          "POST",
          null,
          firstResource === "numbers" ? flow : number
        );
        void pending.catch(() => {});
        await assertBlocked(f.pool, bp, ap);
        resume.resolve();
        await one;
        await assert.rejects(
          pending,
          (e) => e instanceof InboundAdminError && e.code === "owned_did_forwarding_loop"
        );
        assert.equal(
          (await f.pool.query("select * from inbound_numbers")).rowCount,
          firstResource === "numbers" ? 1 : 0
        );
        assert.equal(
          (await f.pool.query("select * from inbound_flow_versions")).rowCount,
          firstResource === "flows" ? 1 : 0
        );
        assert.equal((await f.ledger()).length, 2, "queue plus only the winning configuration mutation");
        assert.equal(f.commands.length, 0);
      } finally {
        resume.resolve();
        await one?.catch(() => {});
        await pending?.catch(() => {});
        await f.cleanup();
      }
    }
  );

test("F01.1–F01.3 DB/API: publisher route bound and disable after campaign archive", options, async () => {
  const f = await fixture();
  try {
    const q = await f.queue();
    const n = await f.save<InboundNumberSnapshot>("POST", "numbers", {
      ...f.numberInput(q.id),
      enabled: true
    });
    await f.pool.query("update campaigns set status='archived' where id=$1", [f.campaign]);
    const off = await f.save<InboundNumberSnapshot>("PATCH", `numbers/${n.id}`, {
      ...f.numberInput(q.id),
      expectedRevision: n.revision
    });
    assert.equal(off.enabled, false);
    const before = await f.state();
    assert.equal(
      (
        await f.request("PATCH", `numbers/${n.id}`, {
          ...f.numberInput(q.id),
          expectedRevision: off.revision,
          enabled: true
        })
      ).json().code,
      "campaign_unavailable"
    );
    assert.deepEqual(await f.state(), before);
    await f.pool.query("update campaigns set status='active' where id=$1", [f.campaign]);
    await f.pool.query(
      `insert into inbound_numbers(normalized_did,label,queue_id)
      select '+1415555'||lpad(i::text,4,'0'),'F01 bound',$1 from generate_series(1000,1198) i`,
      [q.id]
    );
    assert.equal(
      (await f.request("POST", "numbers", f.numberInput(q.id, "+14155550199"))).json().code,
      "route_limit_exceeded"
    );
    assert.equal((await f.pool.query("select * from inbound_numbers")).rowCount, 200);
    assert.equal(f.commands.length, 0);
  } finally {
    await f.cleanup();
  }
});

test(
  "F05.4 DB/API: lowering a queue limit preserves admitted work and records new capacity rejection",
  options,
  async () => {
    const f = await fixture();
    try {
      const { admitInboundQueue, persistInboundQueueEvent } = await import("./inbound-queue.js");
      await f.pool.query(
        "update call_admission_migration set reconciliation_required=false,reconciled_at=clock_timestamp()"
      );
      const q = await f.queue();
      const n = await f.save<InboundNumberSnapshot>("POST", "numbers", f.numberInput(q.id));
      async function ingress() {
        const uuid = randomUUID();
        await importIngressRecord(f.pool, {
          uuid,
          journalId: randomUUID(),
          sequence: 1,
          arrivedUs: Date.now() * 1000,
          did: n.did,
          routeRevision: n.revision,
          numberId: n.id,
          queueId: q.id,
          queueRevision: q.revision,
          campaignId: f.campaign,
          timeoutMs: 60000,
          routeData: Buffer.from(JSON.stringify({ queue_timeout_ms: 60000, max_waiting_calls: 40 })).toString(
            "base64url"
          ),
          callingNumber: "unknown",
          terminalUs: null,
          terminalReason: null
        });
        return uuid;
      }
      const a = await ingress(),
        b = await ingress();
      assert.ok(await admitInboundQueue(f.pool, a));
      assert.ok(await admitInboundQueue(f.pool, b));
      const before = (
        await f.pool.query("select * from calls where id=any($1::uuid[]) order by id", [[a, b]])
      ).rows;
      const permits = (await f.pool.query("select * from call_capacity_reservations order by id")).rows;
      const updated = await f.save<InboundQueueSnapshot>("PATCH", `queues/${q.id}`, {
        ...f.queueInput(),
        expectedRevision: q.revision,
        configuration: { ...q.configuration, maxWaitingCalls: 1 }
      });
      assert.equal(updated.configuration.maxWaitingCalls, 1);
      assert.deepEqual(
        (await f.pool.query("select * from calls where id=any($1::uuid[]) order by id", [[a, b]])).rows,
        before
      );
      assert.deepEqual(
        (await f.pool.query("select * from call_capacity_reservations order by id")).rows,
        permits
      );
      const c = await ingress();
      assert.equal(await admitInboundQueue(f.pool, c), null);
      const rejected = (await f.pool.query("select state,inbound_end_reason from calls where id=$1", [c]))
        .rows[0];
      assert.deepEqual(rejected, { state: "failed", inbound_end_reason: "capacity_exceeded" });
      for (const table of ["call_offers", "call_operations", "call_capacity_reservations"])
        assert.equal(
          (await f.pool.query(`select count(*)::int as n from ${table} where call_id=$1`, [c])).rows[0].n,
          0
        );
      for (const id of [a, b])
        await persistInboundQueueEvent(f.pool, {
          "event-name": "CHANNEL_DESTROY",
          "event-uuid": randomUUID(),
          "unique-id": id,
          variable_outbound_dialer_ingress_uuid: id,
          "hangup-cause": "NORMAL_CLEARING"
        });
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int as n from call_capacity_reservations where state<>'released'"
          )
        ).rows[0].n,
        0
      );
      const d = await ingress();
      assert.ok(await admitInboundQueue(f.pool, d));
    } finally {
      await f.cleanup();
    }
  }
);
