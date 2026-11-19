import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl } from "../../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "../db.js";
import { startIngressAgent } from "../ingress-agent.js";
import { importIngressRecord, reconcileIngress } from "../inbound-ingress.js";
import { deleteRecording } from "./recordings.js";
import { runRetention } from "./retention.js";

test(
  "H04.1 DB: retention removes drained history and media, preserves pending evidence and does not recreate purged ingress",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 },
  async () => {
    const schema = `h04_${randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "h04-retention-"));
    const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
    const pool = new pg.Pool(databaseConfig(testDatabaseUrl(), schema));
    const socket = join(root, "agent.sock");
    const command = async (cmd: string) => {
      assert.equal(cmd, "show channels as json");
      return '{"rows":[]}';
    };
    const agent = await startIngressAgent(socket, command, 3, 0);
    try {
      await admin.query(`create schema ${schema}`);
      await runMigrations(pool);
      const campaign = (await pool.query("insert into campaigns(name) values('H04') returning id")).rows[0]
        .id;
      const queue = (
        await pool.query("insert into inbound_queues(campaign_id,name) values($1,'H04') returning id", [
          campaign
        ])
      ).rows[0].id;
      const inside = randomUUID();
      const uncertain = randomUUID();
      const expired = randomUUID();
      for (const [id, seconds] of [
        [inside, 604740],
        [uncertain, 604860],
        [expired, 604860]
      ] as const) {
        const media = join(root, `${id}.wav`);
        await writeFile(media, "recording fixture");
        // Use seconds so the fixtures are on opposite sides of the exact window.
        await pool.query(
          `insert into calls(id,campaign_id,state,ended_at,destination_number,normalized_destination_number,call_recording_path,call_recording_status)
           values($1,$2,'failed',now()-$3::int*interval '1 second','+12025550100','+12025550100',$4,'available')`,
          [id, campaign, seconds, media]
        );
        await pool.query("insert into call_participants(call_id,role,left_at) values($1,'customer',now())", [
          id
        ]);
        if (id !== inside) {
          const operation = (
            await pool.query(
              `insert into call_operations(call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,
                generation,command_uuid,state,created_at,deadline_at,resolved_at,resolution_evidence)
                values($1::uuid,'retention',$1::uuid::text,repeat('a',64),'hangup',1,gen_random_uuid(),$2,
                  now()-interval '8 days',now()-interval '8 days'+interval '1 second',
                  case when $2='failed' then now()-interval '8 days'+interval '2 seconds' end,
                  case when $2='failed' then 'confirmed isolated fixture' end) returning id`,
              [id, id === uncertain ? "uncertain" : "failed"]
            )
          ).rows[0].id;
          await pool.query(
            `insert into call_capacity_reservations(operation_id,call_id,resource_type,scope_id,state,released_at)
             values($1,$2,'customer_channel','h04',$3,case when $3='released' then now() end)`,
            [operation, id, id === uncertain ? "uncertain" : "released"]
          );
          if (id === expired) {
            await pool.query("insert into call_execution_keys(call_id) values($1)", [id]);
            await pool.query(
              `insert into call_execution_attempts(operation_id,owner_id,backend_pid,replica,seat,transport_protocol)
               values($1,gen_random_uuid(),pg_backend_pid(),0,0,'fs-fenced-v1')`,
              [operation]
            );
            await pool.query(
              "insert into call_command_fences(operation_id,core_uuid) values($1,gen_random_uuid())",
              [operation]
            );
            await pool.query("insert into call_command_receipt_acks(operation_id) values($1)", [operation]);
            await pool.query(
              "insert into service_invite_dialogs(operation_id,dialog_id) values($1,'h04-dialog')",
              [operation]
            );
            await assert.rejects(
              pool.query("delete from call_execution_attempts where operation_id=$1", [operation]),
              /Sender identity must survive its operation/
            );
            await assert.rejects(
              pool.query("delete from call_execution_keys where call_id=$1", [id]),
              /Execution key must survive the call/
            );
          }
        }
      }

      const acknowledged = randomUUID();
      const pending = randomUUID();
      for (const id of [acknowledged, pending]) {
        const arrivedUs = Date.now() * 1000;
        agent.journal.capture({
          uuid: id,
          arrivedUs,
          numberId: randomUUID(),
          campaignId: campaign,
          queueId: queue,
          did: "+12025550100",
          timeoutMs: 60000,
          routeRevision: "1",
          queueRevision: "1",
          routeData: "e30",
          callingNumber: "unknown"
        });
        const row = { ...agent.journal.terminal(id), arrivedUs: arrivedUs - 8 * 86400 * 1000000 };
        row.terminalUs = row.arrivedUs + 1000;
        // Age both sides of the otherwise immutable receipt before the first import.
        agent.journal.db.prepare("update evidence set record=? where uuid=?").run(JSON.stringify(row), id);
        await importIngressRecord(pool, row);
        if (id === acknowledged) {
          agent.journal.acknowledge(id, row.sequence);
          await pool.query(
            "update inbound_ingress_evidence set acknowledged_sequence=2 where ingress_id=$1",
            [id]
          );
        }
      }

      const input = { dryRun: true, callRetentionDays: 7, recordingRetentionDays: 7, pcapRetentionDays: 7 };
      assert.deepEqual(await runRetention(pool, input), {
        ...input,
        calls: 2,
        recordingFiles: 1,
        pcapFiles: 0
      });
      assert.deepEqual(await runRetention(pool, { ...input, dryRun: false }), {
        ...input,
        dryRun: false,
        calls: 2,
        recordingFiles: 1,
        pcapFiles: 0
      });
      await assert.rejects(readFile(join(root, `${expired}.wav`)), { code: "ENOENT" });
      assert.equal(await readFile(join(root, `${inside}.wav`), "utf8"), "recording fixture");
      assert.equal(await readFile(join(root, `${uncertain}.wav`), "utf8"), "recording fixture");
      assert.deepEqual(
        (await pool.query("select call_id from call_participants order by call_id")).rows.map(
          (r) => r.call_id
        ),
        [inside, uncertain].sort()
      );
      assert.deepEqual(
        (await pool.query("select state from call_operations")).rows.map((r) => r.state),
        ["uncertain"]
      );
      for (const table of [
        "call_execution_keys",
        "call_execution_attempts",
        "call_command_fences",
        "call_command_receipt_acks",
        "service_invite_dialogs"
      ]) {
        assert.equal((await pool.query(`select 1 from ${table}`)).rowCount, 0);
      }
      assert.equal(
        (await pool.query("select state from call_capacity_reservations")).rows[0].state,
        "uncertain"
      );
      assert.deepEqual(
        (await pool.query("select ingress_id from inbound_ingress_evidence")).rows.map((r) => r.ingress_id),
        [pending]
      );
      assert.equal((await runRetention(pool, { ...input, dryRun: false })).calls, 0);
      await reconcileIngress(pool, socket, command);
      assert.equal((await pool.query("select id from calls where id=$1", [acknowledged])).rowCount, 0);
      assert.equal(
        (
          await pool.query("select acknowledged_sequence from inbound_ingress_evidence where ingress_id=$1", [
            pending
          ])
        ).rows[0].acknowledged_sequence,
        "2"
      );

      const insertAudio = async (name: string) => {
        const file = join(root, name);
        await writeFile(file, "fixture audio");
        const id = (
          await pool.query(
            "insert into recordings(campaign_id,name,file_path,runtime_file_path) values($1,$2,$3,$3) returning id",
            [campaign, name, file]
          )
        ).rows[0].id;
        return { id, file };
      };
      const pinned = await insertAudio("pinned.wav");
      const unreferenced = await insertAudio("unreferenced.wav");
      await pool.query("update inbound_queues set waiting_audio_id=$1 where id=$2", [pinned.id, queue]);
      assert.equal((await deleteRecording(pool, pinned.id)).status, "in_use");
      const deletion = await deleteRecording(pool, unreferenced.id);
      assert.equal(deletion.status, "deleted");
      await unlink(deletion.filePath);
      assert.equal(await readFile(pinned.file, "utf8"), "fixture audio");
      await assert.rejects(readFile(unreferenced.file), { code: "ENOENT" });
    } finally {
      await agent.close();
      await pool.end();
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  }
);
