import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { databaseConfig, testDatabaseUrl } from "../../../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "./db.js";
import { getCallDetail } from "./dashboard/responders.js";
import { browserMediaTelemetrySchema, upsertBrowserMediaTelemetry } from "./dashboard/browser-media.js";
import { persistCallMediaStats } from "./call-observability.js";
import { getCallParticipationHistory } from "./call-participation.js";

const migrationDirectory = new URL("../db/migrations/", import.meta.url);
const migrationName = "027_call_participation.sql";
const options = {
  skip: !process.env.TEST_DATABASE_URL ? "TEST_DATABASE_URL absent; use test:inbound:db:isolated" : false,
  timeout: 60000
};
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 14, 0, 0, seconds));
async function fixture(upgrade = false) {
  const schema = `b03_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool(databaseConfig(testDatabaseUrl()));
  await admin.query(`create schema ${schema}`);
  const pool = new pg.Pool(databaseConfig(testDatabaseUrl(), schema));
  const cleanup = async () => {
    await pool.end();
    try {
      await admin.query(`drop schema ${schema} cascade`);
      assert.equal((await admin.query("select 1 from pg_namespace where nspname=$1", [schema])).rowCount, 0);
    } finally {
      await admin.end();
    }
  };
  try {
    if (!upgrade) await runMigrations(pool);
    else {
      await pool.query(
        "create table schema_migrations(filename text primary key,checksum_sha256 text,applied_at timestamptz not null default now())"
      );
      for (const name of (await readdir(migrationDirectory))
        .filter((n) => /^\d{3}_.*\.sql$/.test(n) && n < migrationName)
        .sort()) {
        const sql = await readFile(new URL(name, migrationDirectory), "utf8");
        if (/^\s*--\s*outbound-dialer:no-transaction\b/m.test(sql)) {
          for (const statement of sql
            .split(/^\s*--\s*outbound-dialer:statement\s*$/m)
            .map((s) => s.trim())
            .filter(Boolean))
            await pool.query(statement);
        } else await pool.query(sql);
        await pool.query("insert into schema_migrations(filename,checksum_sha256) values($1,$2)", [
          name,
          createHash("sha256").update(sql).digest("hex")
        ]);
      }
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { pool, cleanup };
}
async function agent(pool: pg.Pool) {
  const userId = (
    await pool.query(
      "insert into users(email,name,role,password_hash) values($1,'B03','agent','fixture') returning id",
      [`${randomUUID()}@fixture.invalid`]
    )
  ).rows[0].id as string;
  const id = (
    await pool.query(
      "insert into agents(user_id,sip_username,sip_password_hash,sip_password_encrypted,display_name) values($1,$2,'fixture','fixture','B03') returning id",
      [userId, randomUUID()]
    )
  ).rows[0].id as string;
  return { id, userId };
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof Error && "code" in error && error.code === code
  );
}
function telemetry(start = 10, end = 20, count = 10) {
  return browserMediaTelemetrySchema.parse({
    schemaVersion: 1,
    startedAt: at(start).toISOString(),
    endedAt: at(end).toISOString(),
    sampleCount: count,
    microphone: {
      sampleRate: null,
      sampleSize: null,
      channelCount: null,
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
      latencySeconds: null
    },
    inbound: {
      codec: "PCMU",
      packetsReceived: count,
      packetsLost: null,
      packetsDiscarded: null,
      jitterSecondsMax: null,
      jitterBufferDelaySeconds: null,
      jitterBufferEmittedCount: null,
      concealedSamples: null,
      totalSamplesReceived: null,
      concealmentEvents: null,
      audioEnergy: null,
      audioDurationSeconds: null
    },
    outbound: {
      codec: "PCMU",
      packetsSent: count,
      bytesSent: null,
      remotePacketsLost: null,
      remoteJitterSecondsMax: null,
      roundTripTimeSecondsMax: null
    },
    connection: { localCandidateType: null, remoteCandidateType: null, protocol: null, relayProtocol: null }
  });
}
async function media(
  pool: pg.Pool,
  callId: string,
  legUuid: string,
  callLegId?: string,
  packets = 100,
  time = 40
) {
  return persistCallMediaStats(pool, {
    callId,
    legUuid,
    callLegId,
    legType: "agent",
    eventName: "CHANNEL_HANGUP_COMPLETE",
    frame: {
      body: "",
      headers: {
        "event-date-timestamp": String(BigInt(at(time).getTime()) * 1000n),
        variable_rtp_audio_in_packet_count: String(packets)
      }
    }
  });
}
async function report(pool: pg.Pool, name: string, assertions: string[]) {
  if (!process.env.INBOUND_TEST_ARTIFACTS) return;
  await mkdir(process.env.INBOUND_TEST_ARTIFACTS, { recursive: true });
  await writeFile(
    `${process.env.INBOUND_TEST_ARTIFACTS}/b03-${name}-report.json`,
    JSON.stringify(
      {
        status: "passed",
        baseRevision: "af5b8ab",
        database: (await pool.query("select version() as version")).rows[0].version,
        media: "none; real PostgreSQL with synthetic call/telemetry fixtures, no FS/browser/provider proof",
        assertions,
        calls: (
          await pool.query(
            "select id,direction,campaign_id,agent_id,state,arrived_at,pstn_answered_at,agent_connected_at from calls order by id"
          )
        ).rows,
        participants: (await pool.query("select * from call_participants order by id")).rows,
        legStats: (
          await pool.query(
            "select call_leg_id,call_id,inbound_packet_count from call_leg_media_stats order by call_leg_id"
          )
        ).rows,
        browserStats: (
          await pool.query(
            "select participant_id,call_id,sample_count from call_participant_browser_media_stats order by participant_id"
          )
        ).rows
      },
      null,
      2
    ) + "\n"
  );
}

for (const upgrade of [false, true])
  test(
    `B03.1/B03.3 ${upgrade ? "upgrade from 026" : "fresh"}: legacy API/media readers, additive data and replay`,
    options,
    async () => {
      const db = await fixture(upgrade);
      const { pool } = db;
      try {
        const a = await agent(pool);
        const c = (
          await pool.query(
            "insert into calls(agent_id,destination_number,normalized_destination_number,state,answered_at,ended_at) values($1,'+14155550100','+14155550100','completed',$2,$3) returning id",
            [a.id, at(10), at(40)]
          )
        ).rows[0].id as string;
        const uuid = randomUUID();
        const leg = (
          await pool.query(
            "insert into call_legs(call_id,type,freeswitch_uuid,state,started_at,answered_at,ended_at) values($1,'agent',$2,'ended',$3,$4,$5) returning id",
            [c, uuid, at(1), at(2), at(40)]
          )
        ).rows[0].id as string;
        await media(pool, c, uuid);
        // Pre-027 fixture uses the legacy table shape; the new writer requires 027.
        await pool.query(
          "insert into call_browser_media_stats(call_id,schema_version,started_at,ended_at,sample_count) values($1,1,$2,$3,10)",
          [c, at(10), at(20)]
        );
        const unmatched = (
          await pool.query(
            "insert into calls(destination_number,normalized_destination_number,state,ended_at) values('legacy','legacy','completed',$1) returning id",
            [at(40)]
          )
        ).rows[0].id as string;
        await pool.query("insert into call_legs(call_id,type,state,ended_at) values($1,'agent','ended',$2)", [
          unmatched,
          at(40)
        ]);
        await media(pool, unmatched, randomUUID()); // no matching leg UUID or known owner
        await pool.query(
          "insert into call_browser_media_stats(call_id,schema_version,started_at,ended_at,sample_count) values($1,1,$2,$3,10)",
          [unmatched, at(10), at(20)]
        );
        const ambiguous = (
          await pool.query(
            "insert into calls(agent_id,destination_number,normalized_destination_number,state,ended_at) values($1,'legacy','legacy','completed',$2) returning id",
            [a.id, at(40)]
          )
        ).rows[0].id as string;
        await pool.query(
          "insert into call_legs(call_id,type,state) values($1,'agent','created'),($1,'agent','created')",
          [ambiguous]
        );
        await pool.query(
          "insert into call_browser_media_stats(call_id,schema_version,started_at,ended_at,sample_count) values($1,1,$2,$3,10)",
          [ambiguous, at(10), at(20)]
        );
        // The current H03 reader requires current migrations. A pre-027 schema
        // is an upgrade input, not a supported runtime schema for the new API.
        const before = upgrade ? null : await getCallDetail(pool, c);
        const rawBefore = (await pool.query("select * from calls where id=$1", [c])).rows[0];
        const legsBefore = (await pool.query("select * from call_legs where call_id=$1", [c])).rows;
        const statsBefore = (await pool.query("select * from call_media_stats where call_id=$1", [c])).rows;
        const browserBefore = (
          await pool.query("select * from call_browser_media_stats where call_id=$1", [c])
        ).rows;
        const checksums = (
          await pool.query("select * from schema_migrations where filename<$1 order by filename", [
            migrationName
          ])
        ).rows;
        await runMigrations(pool);
        await runMigrations(pool);
        const rawAfter = (await pool.query("select * from calls where id=$1", [c])).rows[0];
        for (const key of Object.keys(rawBefore)) assert.deepEqual(rawAfter[key], rawBefore[key], key);
        for (const row of (await pool.query("select * from call_legs where call_id=$1", [c])).rows)
          for (const key of Object.keys(legsBefore[0]).filter((k) => k !== "participant_id"))
            assert.deepEqual(row[key], legsBefore[0][key], key);
        assert.equal(rawAfter.direction, "outbound");
        assert.equal(rawAfter.agent_connected_at, null); // old answer was not bridge proof
        const after = await getCallDetail(pool, c);
        if (before) assert.deepEqual(after, before);
        else {
          assert.equal(after?.call.id, c);
          assert.equal(after?.call.state, rawBefore.state);
          assert.equal(after?.call.outcome, rawBefore.outcome);
          assert.equal(after?.call.answeredAt, rawBefore.answered_at.toISOString());
          assert.equal(after?.call.endedAt, rawBefore.ended_at.toISOString());
          assert.equal(after?.call.durationSeconds, 30);
          assert.equal(after?.call.context?.direction, "outbound");
          assert.equal(after?.legs[0].freeswitchUuid, uuid);
          assert.equal(
            after?.mediaQuality[0].inboundPacketCount,
            Number(statsBefore[0].inbound_packet_count)
          );
          assert.equal(after?.browserMedia?.sampleCount, browserBefore[0].sample_count);
        }
        assert.deepEqual(
          (await pool.query("select * from call_media_stats where call_id=$1", [c])).rows,
          statsBefore
        );
        assert.deepEqual(
          (await pool.query("select * from call_browser_media_stats where call_id=$1", [c])).rows,
          browserBefore
        );
        assert.deepEqual(
          (
            await pool.query("select * from schema_migrations where filename<$1 order by filename", [
              migrationName
            ])
          ).rows,
          checksums
        );
        if (upgrade) {
          assert.equal(
            (await pool.query("select * from call_leg_media_stats where call_leg_id=$1", [leg])).rows[0]
              .inbound_packet_count,
            "100"
          );
          assert.equal(
            (
              await pool.query("select * from call_participant_browser_media_stats where participant_id=$1", [
                leg
              ])
            ).rows[0].sample_count,
            10
          );
          assert.equal(
            (await pool.query("select * from call_participants where id=$1", [leg])).rows[0].connected_at,
            null
          );
        }
        for (const retained of [unmatched, ambiguous]) {
          assert.equal(
            (await pool.query("select * from call_browser_media_stats where call_id=$1", [retained]))
              .rowCount,
            1
          );
          assert.equal(
            (
              await pool.query("select * from call_participant_browser_media_stats where call_id=$1", [
                retained
              ])
            ).rowCount,
            0
          );
        }
        assert.equal(
          (await pool.query("select * from call_media_stats where call_id=$1", [unmatched])).rowCount,
          1
        );
        assert.equal(
          (await pool.query("select * from call_leg_media_stats where call_id=$1", [unmatched])).rowCount,
          0
        );
        // Immediately previous API writer still works on feature-off schema 027.
        assert.equal(await media(pool, c, uuid, undefined, 101), true);
        assert.equal(
          await upsertBrowserMediaTelemetry(pool, {
            callId: c,
            userId: a.userId,
            telemetry: telemetry(10, 21, 11)
          }),
          true
        );
        await rejectsCode(pool.query("update calls set state='queued' where id=$1", [c]), "23514");
        await report(pool, upgrade ? "upgrade" : "fresh", [
          "H03 current reader preserves legacy response fields after required schema upgrade",
          "original call/leg/media columns and checksums retained",
          "legacy media writes work after 027; concrete migration copies unambiguous evidence only",
          "legacy terminal progression guard preserved"
        ]);
      } finally {
        await db.cleanup();
      }
    }
  );

for (const direction of ["inbound", "outbound"] as const)
  test(
    `B03.1–B03.3 native ${direction}, repeated cross-campaign legs, late evidence and bounded former-agent media`,
    options,
    async () => {
      const db = await fixture();
      const { pool } = db;
      try {
        const a = await agent(pool),
          b = await agent(pool);
        const campaign = (await pool.query("insert into campaigns(name) values('B03 original') returning id"))
          .rows[0].id as string;
        const otherCampaign = (
          await pool.query("insert into campaigns(name) values('B03 selected by recipient') returning id")
        ).rows[0].id as string;
        await pool.query(
          "insert into agent_desk_sessions(agent_id,campaign_id,binding_generation,sip_username,expires_at) values($1,$2,1,$3,now()+interval '1 hour')",
          [b.id, otherCampaign, randomUUID()]
        );
        const queue = (
          await pool.query(
            "insert into inbound_queues(campaign_id,name) values($1,'B03 shared') returning id",
            [campaign]
          )
        ).rows[0].id;
        const callId = (
          await pool.query(
            `insert into calls(direction,campaign_id,inbound_queue_id,original_did,calling_number,called_number,arrived_at,queue_deadline_at,destination_number,normalized_destination_number,state)
      values($5,$1,$2,'+14155550100','anonymous','+14155550100',$3,$4,'+14155550100','+14155550100','queued') returning id`,
            [campaign, queue, at(0), at(60), direction]
          )
        ).rows[0].id as string;
        assert.equal(
          (await pool.query("select agent_id,contact_id from calls where id=$1", [callId])).rows[0].agent_id,
          null
        );
        assert.equal(
          (await pool.query("select agent_id,contact_id from calls where id=$1", [callId])).rows[0]
            .contact_id,
          null
        );
        assert.equal((await getCallParticipationHistory(pool, callId))?.queueWaitMs, null);
        const excludedQueuedReader = (await getCallDetail(pool, callId))!;
        assert.equal(excludedQueuedReader.call.state as string, "queued");
        assert.equal("direction" in excludedQueuedReader.call, false); // unsupported legacy contract
        assert.equal("participants" in excludedQueuedReader, false);
        await pool.query("update calls set pstn_answered_at=$2 where id=$1", [callId, at(1)]);
        assert.equal((await getCallParticipationHistory(pool, callId))?.queueWaitMs, null);
        const ids: string[] = [];
        const legs: string[] = [];
        const uuids: string[] = [];
        for (const [index, owner] of [a, b, a].entries()) {
          const p = (
            await pool.query(
              "insert into call_participants(call_id,role,agent_id,joined_at,left_at) values($1,'agent',$2,$3,$4) returning id",
              [callId, owner.id, at(10 + index * 10), at(20 + index * 10)]
            )
          ).rows[0].id as string;
          // End event first, then older bridge event. Event time, not ingest time.
          await pool.query("update call_participants set connected_at=$2 where id=$1", [
            p,
            at(11 + index * 10)
          ]);
          const uuid = randomUUID();
          const leg = (
            await pool.query(
              "insert into call_legs(call_id,type,participant_id,freeswitch_uuid) values($1,'agent',$2,$3) returning id",
              [callId, p, uuid]
            )
          ).rows[0].id as string;
          ids.push(p);
          legs.push(leg);
          uuids.push(uuid);
          assert.equal(await media(pool, callId, uuid, leg, 100 + index), true);
          assert.equal(
            await upsertBrowserMediaTelemetry(pool, {
              callId,
              userId: owner.userId,
              participantId: p,
              telemetry: telemetry(10 + index * 10, 20 + index * 10, 10 + index)
            }),
            true
          );
          await pool.query("update calls set agent_id=$2 where id=$1", [callId, owner.id]);
        }
        await pool.query(
          "update calls set agent_connected_at=$2,queue_exited_at=$2,state='agent_connected' where id=$1",
          [callId, at(11)]
        );
        const history = (await getCallParticipationHistory(pool, callId))!;
        assert.equal(history.currentAgentId, a.id);
        assert.equal(history.campaignId, campaign);
        assert.equal(history.queueWaitMs, 11000);
        assert.equal(history.pstnToAgentMs, 10000);
        assert.deepEqual(
          history.participants.map((p) => p.connectedMs),
          [9000, 9000, 9000]
        );
        assert.deepEqual(
          history.participants.map((p) => p.agentId),
          [a.id, b.id, a.id]
        );
        await rejectsCode(
          pool.query("update calls set campaign_id=$2 where id=$1", [callId, otherCampaign]),
          "23514"
        );
        await rejectsCode(
          pool.query("update calls set original_did='changed' where id=$1", [callId]),
          "23514"
        );
        await rejectsCode(
          pool.query("update calls set agent_connected_at=$2 where id=$1", [callId, at(0)]),
          "23514"
        );
        await rejectsCode(
          pool.query("update call_participants set connected_at=$2 where id=$1", [ids[0], at(21)]),
          "23514"
        );
        await rejectsCode(
          pool.query("update call_participants set agent_id=$2 where id=$1", [ids[0], b.id]),
          "23514"
        );
        await rejectsCode(
          pool.query("update call_legs set participant_id=$2 where id=$1", [legs[0], ids[1]]),
          "23514"
        );
        const other = (
          await pool.query(
            "insert into calls(destination_number,normalized_destination_number) values('fixture','fixture') returning id"
          )
        ).rows[0].id;
        await rejectsCode(
          pool.query("insert into call_legs(call_id,type,participant_id) values($1,'agent',$2)", [
            other,
            ids[0]
          ]),
          "23503"
        );
        await rejectsCode(
          pool.query("insert into call_legs(call_id,type,participant_id) values($1,'customer',$2)", [
            callId,
            ids[0]
          ]),
          "23503"
        );
        await pool.query(
          "update agent_call_slots set state='free',reservation_id=null,reconciliation_required=false where agent_id=$1",
          [b.id]
        );
        await rejectsCode(
          pool.query(
            "update agent_call_slots set state='reserved',reservation_id=$4,call_id=$2,participant_id=$3 where agent_id=$1",
            [b.id, callId, ids[0], randomUUID()]
          ),
          "23503"
        );
        assert.equal(await media(pool, callId, uuids[0], legs[0], 1, 39), false); // older sample
        assert.equal(await media(pool, other, uuids[0], legs[0]), false);
        assert.equal(await media(pool, callId, uuids[1], legs[0]), false);
        assert.equal(
          await upsertBrowserMediaTelemetry(pool, {
            callId,
            userId: a.userId,
            participantId: ids[1],
            telemetry: telemetry(20, 30)
          }),
          false
        );
        assert.equal(
          await upsertBrowserMediaTelemetry(pool, {
            callId,
            userId: a.userId,
            participantId: ids[0],
            telemetry: telemetry(10, 21)
          }),
          false
        );
        assert.equal(
          await upsertBrowserMediaTelemetry(pool, { callId, userId: a.userId, telemetry: telemetry() }),
          false
        ); // legacy route excluded
        assert.equal(
          await upsertBrowserMediaTelemetry(pool, {
            callId,
            userId: b.userId,
            participantId: ids[1],
            telemetry: telemetry(20, 30, 12)
          }),
          true
        ); // former owner
        assert.equal(
          (await pool.query("select * from call_leg_media_stats where call_id=$1", [callId])).rowCount,
          3
        );
        assert.equal(
          (await pool.query("select * from call_participant_browser_media_stats where call_id=$1", [callId]))
            .rowCount,
          3
        );
        assert.equal(
          (await pool.query("select * from call_browser_media_stats where call_id=$1", [callId])).rowCount,
          0
        );
        assert.equal(
          (await pool.query("select * from call_media_stats where call_id=$1", [callId])).rowCount,
          0
        );
        assert.equal((await getCallParticipationHistory(pool, callId))?.campaignId, campaign);
        // Fallback is a different never-connected call, not an erased connection.
        const fallback = (
          await pool.query(
            `insert into calls(direction,campaign_id,inbound_queue_id,original_did,
        calling_number,called_number,arrived_at,queue_deadline_at,destination_number,normalized_destination_number,
        state,pstn_answered_at,queue_exited_at,fallback_started_at)
        select direction,campaign_id,inbound_queue_id,original_did,calling_number,called_number,arrived_at,
          queue_deadline_at,destination_number,normalized_destination_number,'fallback',pstn_answered_at,$2,$2
        from calls where id=$1 returning id`,
            [callId, at(30)]
          )
        ).rows[0].id as string;
        assert.equal((await getCallParticipationHistory(pool, fallback))?.pstnToAgentMs, null);
        assert.equal((await getCallParticipationHistory(pool, fallback))?.queueWaitMs, 30000);
        await pool.query("update calls set state='completed',ended_at=$2 where id=$1", [callId, at(50)]);
        const excludedHistoryReader = (await getCallDetail(pool, callId))!;
        assert.equal(excludedHistoryReader.call.state, "completed");
        assert.equal(excludedHistoryReader.browserMedia, null);
        assert.equal(excludedHistoryReader.mediaQuality.length, 0); // concrete data is invisible to old reader
        assert.equal((await getCallParticipationHistory(pool, callId))?.participants.length, 3);
        await report(pool, `native-${direction}`, [
          "unassigned inbound and distinct PSTN/queue/agent clocks",
          "A->B->A concrete legs and stats without collisions",
          "immutable campaign, participant identity and call-scoped slot/leg FK",
          "former-owner telemetry scoped to own interval; wrong-owner/call/UUID and stale FS samples refused",
          "legacy reader/telemetry exclusion for new histories is explicit; internal history attributes durations per participant"
        ]);
        // Isolated cascade: no active slot/capacity claim; all child evidence is removed.
        await pool.query("update agent_call_slots set call_id=null,participant_id=null where agent_id=$1", [
          b.id
        ]);
        await pool.query("delete from calls where id=$1", [callId]);
        for (const table of [
          "call_participants",
          "call_leg_media_stats",
          "call_participant_browser_media_stats"
        ])
          assert.equal((await pool.query(`select * from ${table} where call_id=$1`, [callId])).rowCount, 0);
      } finally {
        await db.cleanup();
      }
    }
  );
