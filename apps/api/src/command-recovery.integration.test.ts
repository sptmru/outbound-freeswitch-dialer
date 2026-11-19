import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { cleanupFixture } from "../../../tests/fixtures/inbound/cleanup.mjs";
import { limitedExecutor } from "../../../tests/fixtures/inbound/supervisor.mjs";
import { databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { withCallAdmission } from "./call-admission.js";
import { enqueueCallCommand } from "./call-executor.js";
import { acknowledgeResolvedCommandReceipts, recoverCommandReceipts } from "./command-recovery.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 };
async function fixture(armed = true, protocol: string | null = "fs-fenced-v1") {
  const config = databaseConfig(testDatabaseUrl());
  const f = await cleanupFixture(config);
  const limited = await limitedExecutor(f, config);
  const c = await f.seed({ unresolved: true });
  const boot = randomUUID();
  await f.pool.query(
    "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat,transport_protocol) values($1,$2,pg_backend_pid(),0,0,$3)",
    [c.operationId, randomUUID(), protocol]
  );
  await f.pool.query("update call_operations set state='uncertain' where id=$1", [c.operationId]);
  if (armed)
    await f.pool.query("insert into call_command_fences(operation_id,core_uuid) values($1,$2)", [
      c.operationId,
      boot
    ]);
  return {
    ...f,
    c,
    boot,
    executor: limited.executor,
    async cleanup() {
      await limited.close();
      await f.cleanup();
    }
  };
}

test("H01 ACK retries committed native receipts without an ESL observation ticket", options, async () => {
  const f = await fixture();
  try {
    const { command_uuid: job } = (await f.snapshot()).call_operations[0];
    const commands: string[] = [];
    let response = "-ERR journal unavailable";
    const command = async (cmd: string) => {
      if (cmd === "global_getvar conf_dir") return "/test";
      commands.push(cmd);
      return response;
    };
    const pending = async () =>
      (await f.pool.query("select operation_id from call_command_receipt_acks")).rows;
    const ack = () => acknowledgeResolvedCommandReceipts(f.pool, f.executor, command);
    assert.deepEqual(await ack(), []);
    assert.deepEqual(commands, []);
    await f.pool.query(
      "update call_operations set state='failed',resolved_at=clock_timestamp(),resolution_evidence='fixture old work complete' where id=$1",
      [f.c.operationId]
    );
    assert.equal((await ack())[0]?.callId, f.c.callId);
    assert.deepEqual(await pending(), []);
    response = "+OK";
    assert.deepEqual(await ack(), []);
    assert.deepEqual(await pending(), [{ operation_id: f.c.operationId }]);
    assert.deepEqual(await ack(), []);
    assert.deepEqual(
      commands,
      Array(2).fill(`lua /test/scripts/outbound-command.lua ack ${f.boot} ${job} ${f.c.operationId}`)
    );
  } finally {
    await f.cleanup();
  }
});

for (const state of ["revoked", "obsolete", "unarmed"])
  test(`H01 sender fence ${state} resolves old work without manufacturing success`, options, async () => {
    const f = await fixture(state !== "unarmed");
    try {
      const commands: string[] = [];
      const actual = state === "obsolete" ? randomUUID() : f.boot;
      await recoverCommandReceipts(
        f.pool,
        f.executor,
        f.c.callId,
        async (cmd) => {
          commands.push(cmd);
          if (cmd === "global_getvar conf_dir") return "/test";
          if (cmd.includes(" ack ")) return "+OK";
          return `${actual}|${state}||`;
        },
        () => true
      );
      const op = (await f.snapshot()).call_operations[0];
      assert.equal(op.state, "failed");
      assert.equal(op.result.fence, state);
      assert.equal(
        (await f.snapshot()).agent_call_slots[0].call_id,
        f.c.callId,
        "resolution is distinct from leg cleanup"
      );
      assert.ok(commands.every((c) => !c.startsWith("uuid_") && !c.startsWith("originate")));
      assert.equal(
        (
          await f.pool.query(
            "select count(*)::int n from call_events where freeswitch_event_name='BACKGROUND_JOB'"
          )
        ).rows[0].n,
        0
      );
    } finally {
      await f.cleanup();
    }
  });
test(
  "H01 legacy sender, running receipt and changed persistence ticket retain uncertainty",
  options,
  async () => {
    for (const mode of ["legacy", "started", "stale"]) {
      const f = await fixture(true, mode === "legacy" ? null : "fs-fenced-v1");
      try {
        const before = await f.snapshot();
        let valid = true;
        await recoverCommandReceipts(
          f.pool,
          f.executor,
          f.c.callId,
          async (cmd) => {
            if (mode === "legacy") throw new Error("legacy sender has no incarnation authority");
            if (cmd === "global_getvar conf_dir") return "/test";
            if (mode === "stale") valid = false;
            return `${f.boot}|${mode === "started" ? "started" : "revoked"}||`;
          },
          () => valid
        );
        assert.deepEqual(await f.snapshot(), before);
      } finally {
        await f.cleanup();
      }
    }
  }
);

test(
  "H01 completed native receipt requires exact live channel profile effect before restoring a missed answered leg",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.pool.query(
        "update call_operations set state='failed',resolved_at=clock_timestamp(),resolution_evidence='fixture old work complete' where id=$1",
        [f.c.operationId]
      );
      const leg = (
        await f.pool.query("select * from call_legs where call_id=$1 and type='agent'", [f.c.callId])
      ).rows[0];
      await f.pool.query("update call_legs set answered_at=null,state='started' where id=$1", [leg.id]);
      const id = randomUUID(),
        job = randomUUID(),
        client = await f.pool.connect();
      try {
        await withCallAdmission(client, { callIds: [f.c.callId] }, async (a) => {
          await enqueueCallCommand(a, {
            id,
            callId: f.c.callId,
            scope: "h01-positive",
            key: "originate",
            fingerprint: "a".repeat(64),
            kind: "originate",
            generation: "1",
            commandUuid: job,
            targetUuid: leg.freeswitch_uuid,
            request: {
              inboundConnection: true,
              connectionAction: "originate",
              agentUuid: leg.freeswitch_uuid,
              participantId: leg.participant_id
            },
            deadline: new Date(Date.now() + 60000)
          });
        });
      } finally {
        client.release();
      }
      await f.pool.query(
        "insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat,transport_protocol) values($1,$2,pg_backend_pid(),0,0,'fs-fenced-v1')",
        [id, randomUUID()]
      );
      await f.pool.query("update call_operations set state='uncertain' where id=$1", [id]);
      await f.pool.query("insert into call_command_fences(operation_id,core_uuid) values($1,$2)", [
        id,
        f.boot
      ]);
      for (const answered of [false, true]) {
        await recoverCommandReceipts(
          f.pool,
          f.executor,
          f.c.callId,
          async (command) => {
            if (command === "global_getvar conf_dir") return "/fixture";
            if (command.includes(" inspect "))
              return `${f.boot}|completed|${Buffer.from("+OK " + leg.freeswitch_uuid).toString("hex")}|`;
            if (command.includes(" ack ")) return "+OK";
            if (command === `uuid_exists ${leg.freeswitch_uuid}`) return "true";
            assert.equal(command, `uuid_dump ${leg.freeswitch_uuid}`);
            return `Unique-ID: ${leg.freeswitch_uuid}\nCaller-Channel-Answered-Time: ${answered ? "1794988000000000" : "0"}\n`;
          },
          () => true
        );
        assert.equal(
          Boolean(
            (await f.pool.query("select answered_at from call_legs where id=$1", [leg.id])).rows[0]
              .answered_at
          ),
          answered
        );
      }
      assert.equal(
        (
          await f.pool.query(
            "select freeswitch_event_name from call_events where raw_json->>'operationId'=$1",
            [id]
          )
        ).rows[0].freeswitch_event_name,
        "RECOVERY_NATIVE_RECEIPT"
      );
      assert.equal(
        (await f.pool.query("select state from call_operations where id=$1", [id])).rows[0].state,
        "uncertain",
        "the action-specific resolver still owns command resolution"
      );
    } finally {
      await f.cleanup();
    }
  }
);
