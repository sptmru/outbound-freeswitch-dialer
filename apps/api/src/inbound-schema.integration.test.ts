import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { deleteRecording } from "./dashboard/recordings.js";
import { normalizeInboundNumber } from "./inbound-configuration.js";

const migrationDirectory = new URL("../db/migrations/", import.meta.url);
const migrationName = "025_inbound_routing.sql";

async function fixture() {
  const url = testDatabaseUrl();
  const schema = `b01_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(url));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool(databaseConfig(url, schema));
  return {
    pool,
    async cleanup() {
      await pool.end();
      try {
        await admin.query(`drop schema ${schema} cascade`);
        assert.equal(
          (await admin.query("select 1 from pg_namespace where nspname=$1", [schema])).rowCount,
          0
        );
      } finally {
        await admin.end();
      }
    }
  };
}

// Reconstruct the exact existing 001–024 schema and checksums, then use the product
// runner for the upgrade. No applied source is rewritten and no app DB is consulted.
async function installPreviousSchema(pool: pg.Pool) {
  await pool.query(
    "create table schema_migrations(filename text primary key, checksum_sha256 text, applied_at timestamptz not null default now())"
  );
  for (const filename of (await readdir(migrationDirectory))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name) && name < migrationName)
    .sort()) {
    const sql = await readFile(new URL(filename, migrationDirectory), "utf8");
    if (/^\s*--\s*outbound-dialer:no-transaction\b/m.test(sql)) {
      for (const statement of sql
        .split(/^\s*--\s*outbound-dialer:statement\s*$/m)
        .map((part) => part.trim())
        .filter(Boolean))
        await pool.query(statement);
    } else {
      await pool.query(sql);
    }
    await pool.query("insert into schema_migrations(filename,checksum_sha256) values ($1,$2)", [
      filename,
      createHash("sha256").update(sql).digest("hex")
    ]);
  }
}

async function seed(pool: pg.Pool) {
  const campaign = (
    await pool.query(
      "insert into campaigns(name,status,manual_dialing_enabled) values ('B01 existing outbound','active',true) returning id"
    )
  ).rows[0].id as string;
  const otherCampaign = (await pool.query("insert into campaigns(name) values ('B01 other') returning id"))
    .rows[0].id as string;
  const audio = (
    await pool.query(
      "insert into recordings(name,file_path,runtime_file_path,campaign_id,duration_seconds) values ('old audio','/fixture/old.wav','/runtime/old.wav',$1,30) returning id",
      [campaign]
    )
  ).rows[0].id as string;
  const otherAudio = (
    await pool.query(
      "insert into recordings(name,file_path,runtime_file_path,campaign_id,duration_seconds) values ('other audio','/fixture/other.wav','/runtime/other.wav',$1,30) returning id",
      [otherCampaign]
    )
  ).rows[0].id as string;
  await pool.query("update campaigns set voicemail_recording_id=$2 where id=$1", [campaign, audio]);
  const call = (
    await pool.query(
      "insert into calls(campaign_id,destination_number,normalized_destination_number,state,recording_id) values ($1,'+14155550100','+14155550100','created',$2) returning id",
      [campaign, audio]
    )
  ).rows[0].id as string;
  return { campaign, otherCampaign, audio, otherAudio, call };
}

function rejectsCode(promise: Promise<unknown>, code: string) {
  return assert.rejects(
    promise,
    (error: unknown) => error instanceof Error && "code" in error && error.code === code
  );
}

for (const mode of ["fresh", "upgrade"] as const) {
  test(
    `B01.1–B01.3 ${mode}: real PostgreSQL constraints, immutable versions, migration replay and feature-off outbound`,
    {
      skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
      timeout: 60000
    },
    async () => {
      const db = await fixture();
      const { pool } = db;
      const assertions: string[] = [];
      try {
        if (mode === "upgrade") await installPreviousSchema(pool);
        else await runMigrations(pool);
        const seeded = await seed(pool);
        const { campaign, otherCampaign, audio, otherAudio, call } = seeded;
        const before = (
          await pool.query("select row_to_json(c) as campaign from campaigns c where id=$1", [campaign])
        ).rows;
        const mediaBefore = (
          await pool.query("select * from recordings where campaign_id=$1 order by id", [campaign])
        ).rows;
        const callsBefore = (await pool.query("select * from calls where id=$1", [call])).rows;
        const oldChecksums = (
          await pool.query("select * from schema_migrations where filename < $1 order by filename", [
            migrationName
          ])
        ).rows;
        await runMigrations(pool);
        await runMigrations(pool);
        assert.deepEqual(
          (
            await pool.query("select * from schema_migrations where filename < $1 order by filename", [
              migrationName
            ])
          ).rows,
          oldChecksums
        );
        assert.deepEqual(
          (await pool.query("select row_to_json(c) as campaign from campaigns c where id=$1", [campaign]))
            .rows,
          before
        );
        assert.deepEqual(
          (await pool.query("select * from recordings where campaign_id=$1 order by id", [campaign])).rows,
          mediaBefore
        );
        assert.deepEqual((await pool.query("select * from calls where id=$1", [call])).rows, callsBefore);
        assert.equal((await pool.query("select * from inbound_numbers")).rowCount, 0);
        const migrations = (await pool.query("select * from schema_migrations order by filename")).rows;
        assert.equal(migrations.length, 25);
        for (const row of migrations)
          assert.equal(
            row.checksum_sha256,
            createHash("sha256")
              .update(await readFile(new URL(row.filename, migrationDirectory)))
              .digest("hex")
          );
        assertions.push(
          "B01.3 25 checksums stable; migration runner twice; outbound campaign/audio/call unchanged; no seeded routes"
        );

        const flow = (
          await pool.query(
            "insert into inbound_flows(campaign_id,name) values ($1,'No answer') returning id",
            [campaign]
          )
        ).rows[0].id;
        const actions = [
          { type: "play_audio", recordingId: audio, timeoutMs: 30000 },
          { type: "forward_external", target: "+14155550101", timeoutMs: 20000 },
          { type: "play_audio", recordingId: audio, timeoutMs: 30000 }
        ];
        const saveVersion = async (version: number, steps: unknown, timeout = 90000) =>
          pool.query(
            "insert into inbound_flow_versions(flow_id,campaign_id,version,actions,flow_timeout_ms) values ($1,$2,$3,$4,$5) returning *",
            [flow, campaign, version, JSON.stringify(steps), timeout]
          );
        const v1 = (await saveVersion(1, actions)).rows[0];
        assert.equal(v1.first_audio_id, audio);
        assert.equal(v1.second_audio_id, audio);
        assert.equal(v1.audio_snapshot[0].runtimeFilePath, "/runtime/old.wav");
        // B03 owns the product calls extension; a FK fixture proves the B01 version
        // contract against a real existing call without implementing B03 early.
        await pool.query(
          "create table b01_call_flow_references(call_id uuid primary key references calls(id), flow_version_id uuid not null references inbound_flow_versions(id))"
        );
        await pool.query("insert into b01_call_flow_references values ($1,$2)", [call, v1.id]);
        const queue = (
          await pool.query(
            "insert into inbound_queues(campaign_id,name,waiting_audio_id,no_answer_flow_version_id) values ($1,'Shared',$2,$3) returning *",
            [campaign, audio, v1.id]
          )
        ).rows[0];
        for (const number of ["+1 (415) 555-0100", "+14155550102"]) {
          const did = (
            await pool.query(
              "insert into inbound_numbers(normalized_did,label,queue_id) values ($1,'DID',$2) returning *",
              [normalizeInboundNumber(number), queue.id]
            )
          ).rows[0];
          assert.equal(did.enabled, false);
          assert.equal(did.desired_revision, "1");
          assert.equal(did.applied_revision, null);
        }
        assert.equal(
          (await pool.query("select * from inbound_numbers where queue_id=$1", [queue.id])).rowCount,
          2
        );
        await rejectsCode(
          pool.query(
            "insert into inbound_numbers(normalized_did,label,queue_id) values ($1,'Duplicate',$2)",
            [normalizeInboundNumber("0014155550100"), queue.id]
          ),
          "23505"
        );
        await rejectsCode(
          pool.query(
            "insert into inbound_numbers(normalized_did,label,queue_id) values ('14155550103','Bad',$1)",
            [queue.id]
          ),
          "23514"
        );
        await rejectsCode(
          pool.query(
            "insert into inbound_numbers(normalized_did,label,queue_id) values ('+14155550103','Bad',$1)",
            [randomUUID()]
          ),
          "23503"
        );
        await rejectsCode(
          pool.query("update inbound_queues set campaign_id=$2 where id=$1", [queue.id, otherCampaign]),
          "23503"
        );
        await rejectsCode(
          pool.query("update inbound_queues set waiting_audio_id=$2 where id=$1", [queue.id, otherAudio]),
          "23503"
        );
        await rejectsCode(
          pool.query("update inbound_queues set no_answer_flow_version_id=$2 where id=$1", [
            queue.id,
            randomUUID()
          ]),
          "23503"
        );
        await rejectsCode(
          saveVersion(2, [{ type: "play_audio", recordingId: otherAudio, timeoutMs: 30000 }]),
          "23503"
        );
        for (const [column, min, max] of [
          ["offer_timeout_ms", 5000, 30000],
          ["queue_timeout_ms", 15000, 300000],
          ["connect_timeout_ms", 6000, 15000],
          ["transfer_timeout_ms", 5000, 30000],
          ["max_waiting_calls", 1, 200]
        ] as const) {
          for (const value of [min, max])
            await pool.query(`update inbound_queues set ${column}=$2 where id=$1`, [queue.id, value]);
          await pool.query(`update inbound_queues set ${column}=$2 where id=$1`, [queue.id, queue[column]]);
          for (const value of [min - 1, max + 1])
            await rejectsCode(
              pool.query(`update inbound_queues set ${column}=$2 where id=$1`, [queue.id, value]),
              "23514"
            );
        }
        await rejectsCode(
          pool.query(
            "update inbound_queues set connect_timeout_ms=15000,queue_timeout_ms=15000 where id=$1",
            [queue.id]
          ),
          "23514"
        );
        await rejectsCode(
          pool.query("update inbound_queues set overflow_policy='flow' where id=$1", [queue.id]),
          "23514"
        );
        await pool.query(
          "update inbound_queues set overflow_policy='flow',overflow_flow_version_id=$2 where id=$1",
          [queue.id, v1.id]
        );
        await rejectsCode(
          pool.query("update inbound_queues set overflow_policy='recursive' where id=$1", [queue.id]),
          "23514"
        );
        await rejectsCode(
          pool.query("update inbound_queues set applied_revision=desired_revision+1 where id=$1", [queue.id]),
          "23514"
        );
        await pool.query("update inbound_queues set applied_revision=desired_revision where id=$1", [
          queue.id
        ]);
        const applied = (await pool.query("select * from inbound_queues where id=$1", [queue.id])).rows[0];
        await pool.query(
          "update inbound_queues set name='Edited',desired_revision=999999,applied_revision=999999 where id=$1",
          [queue.id]
        );
        const edited = (await pool.query("select * from inbound_queues where id=$1", [queue.id])).rows[0];
        assert.equal(BigInt(edited.desired_revision), BigInt(applied.desired_revision) + 1n);
        assert.equal(edited.applied_revision, applied.applied_revision);
        await pool.query("update inbound_numbers set applied_revision=desired_revision");
        await pool.query("update inbound_numbers set label='Edited'");
        for (const row of (await pool.query("select * from inbound_numbers")).rows) {
          assert.equal(row.desired_revision, "2");
          assert.equal(row.applied_revision, "1");
          assert.equal(row.enabled, false);
        }
        assertions.push(
          "B01.1 shared queue, normalized DID uniqueness, FK/campaign ownership, A06 bounds and desired/applied revisions"
        );

        for (const invalid of [
          [],
          [{ type: "loop" }],
          [{ type: "hangup" }, { type: "hangup" }],
          [actions[1], actions[1]],
          [actions[0], actions[0], actions[0]],
          [{ ...actions[0], timeoutMs: 999 }],
          [{ ...actions[1], timeoutMs: 30001 }],
          [{ ...actions[1], target: "sip:evil@example.com" }],
          [{ ...actions[0], extra: true }],
          [{ type: "play_audio", timeoutMs: 1000 }],
          [{ type: "forward_external", target: "+14155550101", timeoutMs: 5000.5 }]
        ]) {
          await rejectsCode(saveVersion(2, invalid), "23514");
        }
        await rejectsCode(saveVersion(2, actions, 79999), "23514");
        for (const timeout of [999, 180001]) {
          await rejectsCode(saveVersion(2, [{ type: "hangup" }], timeout), "23514");
        }
        await rejectsCode(saveVersion(1, [{ type: "hangup" }]), "23505");
        const v2 = (await saveVersion(2, [{ type: "hangup" }], 1000)).rows[0];
        assert.notEqual(v1.id, v2.id);
        await rejectsCode(
          pool.query('update inbound_flow_versions set actions=\'[{"type":"hangup"}]\' where id=$1', [v1.id]),
          "23514"
        );
        await rejectsCode(
          pool.query("update inbound_flow_versions set version=99 where id=$1", [v1.id]),
          "23514"
        );
        await rejectsCode(pool.query("delete from inbound_flow_versions where id=$1", [v1.id]), "23514");
        await rejectsCode(pool.query("delete from recordings where id=$1", [audio]), "23503");
        await pool.query("update recordings set runtime_file_path='/runtime/replaced.wav' where id=$1", [
          audio
        ]);
        const retained = (
          await pool.query(
            "select v.* from b01_call_flow_references r join inbound_flow_versions v on v.id=r.flow_version_id where call_id=$1",
            [call]
          )
        ).rows[0];
        assert.deepEqual(retained, v1);
        // Remove outbound assignment/active-call reference to exercise inbound-only protection.
        await pool.query("update campaigns set voicemail_recording_id=null where id=$1", [campaign]);
        await pool.query("update calls set recording_id=null where id=$1", [call]);
        assert.deepEqual(await deleteRecording(pool, audio), { status: "in_use" });
        const waitingOnly = (
          await pool.query(
            "insert into recordings(name,file_path,runtime_file_path,campaign_id) values ('Waiting only','/fixture/waiting.wav','/runtime/waiting.wav',$1) returning id",
            [campaign]
          )
        ).rows[0].id;
        await pool.query("update inbound_queues set waiting_audio_id=$2 where id=$1", [
          queue.id,
          waitingOnly
        ]);
        assert.deepEqual(await deleteRecording(pool, waitingOnly), { status: "in_use" });
        assertions.push(
          "B01.2 saved version update/delete rejected; real call FK fixture retains v1 after v2/media edit; audio delete protected"
        );
        if (process.env.INBOUND_TEST_ARTIFACTS) {
          await mkdir(process.env.INBOUND_TEST_ARTIFACTS, { recursive: true });
          await writeFile(
            `${process.env.INBOUND_TEST_ARTIFACTS}/b01-${mode}-report.json`,
            JSON.stringify(
              {
                status: "passed",
                mode,
                baseRevision: "f4ae996d86e054e1ce1334d5d416019da2dd28ce",
                media: "none; DB/schema evidence only",
                database: (await pool.query("select version() as version")).rows[0].version,
                assertions,
                migrations
              },
              null,
              2
            ) + "\n"
          );
        }
      } finally {
        await db.cleanup();
      }
    }
  );
}
