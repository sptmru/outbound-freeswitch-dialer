import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import pg from "pg";
import { databaseConfig, testDatabaseUrl } from "../tests/fixtures/inbound/database.mjs";
import { runMigrations } from "../apps/api/dist-test/db.js";
import { startIngressAgent } from "../apps/api/dist-test/ingress-agent.js";
import { IngressJournal } from "../apps/api/dist-test/ingress-journal.js";
import { createLifecycleRecovery } from "../apps/api/dist-test/inbound-recovery.js";
import { importIngressRecord, reconcileIngress } from "../apps/api/dist-test/inbound-ingress.js";

const [container, artifacts] = process.argv.slice(2);
assert.match(artifacts, /^\/tmp\/outbound-inbound-db\.[A-Za-z0-9]+$/);
assert.equal(container, `outbound-inbound-db-${basename(artifacts)}`);
assert.equal(
  execFileSync("docker", ["inspect", "--format", "{{.HostConfig.NetworkMode}}", container], {
    encoding: "utf8"
  }).trim(),
  "none"
);
const url = new URL(testDatabaseUrl());
assert.equal(url.searchParams.get("host"), join(artifacts, "socket"));
assert.equal(url.pathname, "/inbound_test");
const targetUrl = new URL(url);
targetUrl.pathname = "/restored_test";
const source = new pg.Pool(databaseConfig(url.href));
const target = new pg.Pool(databaseConfig(targetUrl.href));
const root = mkdtempSync(join(artifacts, "h04-"));
const bundle = join(root, "bundle");
const unpacked = join(root, "unpacked");
const recordings = join(root, "recordings");
const restoredMedia = join(root, "restored-media");
const restoredJournal = join(root, "restored-journal");
for (const path of [bundle, unpacked, recordings, restoredMedia, restoredJournal]) mkdirSync(path);

function pgCommand(args, input) {
  return execFileSync("docker", ["exec", "-i", container, ...args], { input, maxBuffer: 16 * 1024 * 1024 });
}

function journalTool(args, input) {
  return execFileSync(process.execPath, ["scripts/backup-ingress-journal.mjs", ...args], { input });
}

const checksums = [];
function recordChecksum(file, before, after) {
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(hash(before), hash(after), `Restored checksum differed for ${file}`);
  checksums.push(`${hash(after)}  ${file}`);
}

let agent;
try {
  await runMigrations(source);
  const campaign = (await source.query("insert into campaigns(name) values('H04 restore') returning id"))
    .rows[0].id;
  const flow = (
    await source.query("insert into inbound_flows(campaign_id,name) values($1,'Restore flow') returning id", [
      campaign
    ])
  ).rows[0].id;
  const asset = (
    await source.query(
      "insert into recordings(campaign_id,name,file_path,runtime_file_path) values($1,'Fixture',$2,$2) returning id",
      [campaign, "/recordings/fixture.wav"]
    )
  ).rows[0].id;
  const versions = [];
  for (const version of [1, 2]) {
    const actions = JSON.stringify([
      { type: "play_audio", recordingId: asset, timeoutMs: 1000 },
      { type: "hangup" }
    ]);
    versions.push(
      (
        await source.query(
          "insert into inbound_flow_versions(flow_id,campaign_id,version,actions) values($1,$2,$3,$4) returning id",
          [flow, campaign, version, actions]
        )
      ).rows[0].id
    );
  }
  const queue = (
    await source.query(
      "insert into inbound_queues(campaign_id,name,no_answer_flow_version_id) values($1,'H04 restore',$2) returning id",
      [campaign, versions[1]]
    )
  ).rows[0].id;
  writeFileSync(join(recordings, "fixture.wav"), "H04 fixture asset bytes");
  const journalPath = join(root, "ingress.sqlite");
  const journal = new IngressJournal(journalPath, 3);
  const seed = () =>
    journal.capture({
      uuid: randomUUID(),
      arrivedUs: Date.now() * 1000,
      numberId: randomUUID(),
      campaignId: campaign,
      queueId: queue,
      did: "+12025550100",
      routeRevision: "1",
      queueRevision: "1",
      timeoutMs: 60000,
      callingNumber: "unknown",
      routeData: "e30"
    });
  const completed = journal.terminal(seed().uuid);
  const pending = seed();
  await importIngressRecord(source, completed);
  await source.query("insert into call_participants(call_id,role,left_at) values($1,'customer',now())", [
    completed.uuid
  ]);
  journal.acknowledge(completed.uuid, completed.sequence);
  await source.query("update inbound_ingress_evidence set acknowledged_sequence=2 where ingress_id=$1", [
    completed.uuid
  ]);
  writeFileSync(join(bundle, "ingress.sqlite"), journalTool(["snapshot", journalPath]));
  journal.close();
  writeFileSync(
    join(bundle, "database.dump"),
    pgCommand(["pg_dump", "-U", "postgres", "-d", "inbound_test", "-Fc"])
  );
  execFileSync("tar", ["-czf", join(bundle, "recordings.tar.gz"), "-C", recordings, "."]);
  writeFileSync(join(bundle, "metadata.txt"), "ingress_journal=present\npostgres_database=inbound_test\n");
  const packed = join(root, "bundle.tar.gz");
  const encrypted = join(root, "bundle.tar.gz.enc");
  const decrypted = join(root, "decrypted.tar.gz");
  const env = { ...process.env, BACKUP_ENCRYPTION_PASSPHRASE: randomBytes(32).toString("hex") };
  execFileSync("tar", [
    "-czf",
    packed,
    "-C",
    bundle,
    "database.dump",
    "recordings.tar.gz",
    "metadata.txt",
    "ingress.sqlite"
  ]);
  execFileSync(process.execPath, ["scripts/backup-envelope.mjs", "encrypt", packed, encrypted], { env });
  execFileSync(process.execPath, ["scripts/backup-envelope.mjs", "decrypt", encrypted, decrypted], { env });
  execFileSync("tar", ["-xzf", decrypted, "-C", unpacked]);
  for (const file of ["database.dump", "recordings.tar.gz", "ingress.sqlite"]) {
    recordChecksum(file, join(bundle, file), join(unpacked, file));
  }
  const dbDump = readFileSync(join(unpacked, "database.dump"));
  const journalDump = readFileSync(join(unpacked, "ingress.sqlite"));
  const targetJournal = join(restoredJournal, "ingress.sqlite");
  journalTool(["verify", join(unpacked, "ingress.sqlite")]);
  journalTool(["guard", targetJournal], journalDump);
  pgCommand(["pg_restore", "--list"], dbDump);
  pgCommand(["createdb", "-U", "postgres", "restored_test"]);
  pgCommand(
    [
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      "restored_test",
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      "--single-transaction"
    ],
    dbDump
  );
  journalTool(["install", targetJournal], journalDump);
  recordChecksum("installed-ingress.sqlite", join(bundle, "ingress.sqlite"), targetJournal);
  execFileSync("tar", ["-xzf", join(unpacked, "recordings.tar.gz"), "-C", restoredMedia]);
  recordChecksum("fixture.wav", join(recordings, "fixture.wav"), join(restoredMedia, "fixture.wav"));

  const inventory = [
    "select id,version,first_audio_id,audio_snapshot from inbound_flow_versions order by version",
    "select id,no_answer_flow_version_id from inbound_queues",
    "select id,state,ended_at from calls",
    "select id,call_id,role,left_at from call_participants",
    "select ingress_id,journal_id,evidence_sequence,imported_sequence,acknowledged_sequence from inbound_ingress_evidence"
  ];
  for (const sql of inventory)
    assert.deepEqual((await target.query(sql)).rows, (await source.query(sql)).rows);

  const command = async (cmd) => {
    if (cmd === "show channels as json") return '{"rows":[]}';
    assert.equal(cmd, `uuid_exists ${pending.uuid}`);
    return "false";
  };
  const socket = join(restoredJournal, "agent.sock");
  agent = await startIngressAgent(socket, command, 3, 0);
  assert.equal(agent.journal.id, completed.journalId);
  assert.deepEqual(agent.journal.status().unacknowledged, 1);
  const failIfCalled = async () => assert.fail("Ended calls must not schedule recovery work");
  const recovery = createLifecycleRecovery(
    target,
    { inspectCall: failIfCalled },
    {
      ingress: { reconcile: () => reconcileIngress(target, socket, command) },
      connection: { wakeExecutor: failIfCalled },
      transfer: { wakeExecutor: failIfCalled },
      fallback: { tick: failIfCalled },
      control: { wakeExecutor: failIfCalled }
    },
    command
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await recovery.reconcile({ waitForIdle: async () => {}, ticket: () => () => true }), {
      status: "complete",
      calls: []
    });
  }
  const calls = (await target.query("select id,state,ended_at from calls order by id")).rows;
  assert.deepEqual(
    calls.map((call) => call.id),
    [completed.uuid, pending.uuid].sort()
  );
  assert.ok(calls.every((call) => call.state === "failed" && call.ended_at));
  assert.deepEqual(
    calls.find((call) => call.id === completed.uuid),
    (await source.query(inventory[2])).rows[0]
  );
  assert.equal((await target.query("select id from call_operations")).rowCount, 0);
  assert.equal(agent.journal.status().unacknowledged, 0);
  assert.deepEqual(
    (
      await target.query(
        "select evidence_sequence,imported_sequence,acknowledged_sequence from inbound_ingress_evidence where ingress_id=$1",
        [pending.uuid]
      )
    ).rows,
    [{ evidence_sequence: "2", imported_sequence: "2", acknowledged_sequence: "2" }]
  );
  writeFileSync(join(artifacts, "h04-restore-checksums.txt"), checksums.join("\n") + "\n");
  console.log(
    "H04.2 passed: verified authenticated bundle, PostgreSQL and SQLite restore, media and reference checksums, two H01 reconciliations"
  );
} finally {
  await agent?.close();
  await Promise.all([source.end(), target.end()]);
  rmSync(root, { recursive: true, force: true });
}
