import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { createServer } from "node:http";

export const WAIT_US = 60_000_000;
export function openJournal(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=100; PRAGMA synchronous=FULL; PRAGMA max_page_count=64");
  return db;
}

export function initialize(path, slots = 4) {
  assert.ok(Number.isInteger(slots) && slots > 0 && slots <= 100);
  const db = openJournal(path);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA max_page_count=64;
    CREATE TABLE ingress (
      slot INTEGER PRIMARY KEY, state INTEGER NOT NULL CHECK(state IN (0,1,2)),
      uuid TEXT NOT NULL, arrived_us INTEGER NOT NULL, ended_us INTEGER NOT NULL,
      did TEXT NOT NULL, revision TEXT NOT NULL, cause TEXT NOT NULL, ack INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX ingress_uuid ON ingress(uuid) WHERE state<>0;`);
  const insert = db.prepare("INSERT INTO ingress VALUES (?,0,?,0,0,?,?,?,0)");
  for (let i = 0; i < slots; i++) insert.run(i, "0".repeat(36), "+12025550100", "fixture-v1", " ".repeat(32));
  db.close();
}

export function validateRecord(row) {
  assert.match(row.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(Number.isSafeInteger(row.arrived_us) && row.arrived_us > 0);
  assert.equal(row.did, "+12025550100");
  assert.equal(row.revision, "fixture-v1");
  assert.ok([1, 2].includes(row.state));
}

export function capture(db, parameters, terminal = false) {
  const row = {
    uuid: parameters.get("uuid"),
    arrived_us: Number(parameters.get("arrived_us")),
    state: 1,
    did: "+12025550100",
    revision: "fixture-v1"
  };
  validateRecord(row);
  if (!terminal && Date.now() * 1000 > row.arrived_us + 750_000) throw new Error("Capture deadline elapsed");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (terminal) {
      const cause = parameters.get("cause");
      assert.match(cause, /^[A-Z_]{1,32}$/);
      const ended = Number(parameters.get("ended_us"));
      assert.ok(Number.isSafeInteger(ended) && ended >= 0);
      const result = db
        .prepare(
          "UPDATE ingress SET state=2, cause=?, ended_us=?, ack=0 WHERE uuid=? AND arrived_us=? AND state<>0"
        )
        .run(cause, ended, row.uuid, row.arrived_us);
      assert.equal(result.changes, 1);
    } else {
      const existing = db.prepare("SELECT arrived_us FROM ingress WHERE uuid=? AND state<>0").get(row.uuid);
      if (existing) assert.equal(existing.arrived_us, row.arrived_us);
      else {
        const result = db
          .prepare(
            `UPDATE ingress SET state=1, uuid=?, arrived_us=?, ended_us=0, cause=?, ack=0
          WHERE slot=(SELECT min(slot) FROM ingress WHERE state=0)`
          )
          .run(row.uuid, row.arrived_us, " ".repeat(32));
        assert.equal(result.changes, 1, "Journal exhausted");
      }
      if (Date.now() * 1000 > row.arrived_us + 750_000) throw new Error("Capture deadline elapsed");
    }
    db.exec("COMMIT");
    return `stored:${row.uuid}`;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function serve(directory) {
  const db = openJournal(`${directory}/ingress.sqlite`);
  const server = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.end("ready");
      return;
    }
    if (request.method !== "POST" || !["/capture", "/terminal"].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 512) throw new Error("Oversized capture");
      }
      const result = capture(db, new URLSearchParams(body), request.url === "/terminal");
      response.writeHead(201).end(result);
    } catch {
      response.writeHead(503).end("not-stored");
    }
  });
  server.maxConnections = 8;
  server.requestTimeout = 1000;
  server.headersTimeout = 1000;
  server.keepAliveTimeout = 1;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(1000, (socket) => socket.destroy());
  server.listen(8093, "127.0.0.1");
}

// No originate/playback/offer interface exists in this prototype importer.
// An ESL error must throw, never masquerade as authoritative channel absence.
export async function importRecord(client, row, live, failAt) {
  validateRecord(row);
  assert.equal(typeof live, "boolean");
  const terminal = row.state === 2 || !live;
  if (failAt === "before-insert") throw new Error("A03 injected before first INSERT");
  await client.query("BEGIN");
  let committedTerminal;
  try {
    await client
      .query(
        `INSERT INTO a03_calls (ingress_uuid, arrived_us, deadline_us, did, revision, terminal, cause)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (ingress_uuid) DO UPDATE SET
         terminal=a03_calls.terminal OR EXCLUDED.terminal,
         cause=CASE WHEN EXCLUDED.terminal AND EXCLUDED.cause<>'channel_absent_on_recovery' THEN EXCLUDED.cause
           WHEN a03_calls.terminal THEN a03_calls.cause ELSE EXCLUDED.cause END
       WHERE a03_calls.arrived_us=EXCLUDED.arrived_us
         AND a03_calls.did=EXCLUDED.did AND a03_calls.revision=EXCLUDED.revision
       RETURNING ingress_uuid, terminal`,
        [
          row.uuid,
          row.arrived_us,
          row.arrived_us + WAIT_US,
          row.did,
          row.revision,
          terminal,
          terminal ? (row.state === 2 ? row.cause.trim() : "channel_absent_on_recovery") : null
        ]
      )
      .then((result) => {
        assert.equal(result.rowCount, 1, "Immutable ingress identity mismatch");
        committedTerminal = result.rows[0].terminal;
      });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  if (failAt === "after-commit") throw new Error("A03 injected after commit before acknowledgement");
  return committedTerminal;
}

export async function schema(client) {
  await client.query(`CREATE TABLE a03_calls (
    ingress_uuid uuid PRIMARY KEY, arrived_us bigint NOT NULL, deadline_us bigint NOT NULL,
    did text NOT NULL, revision text NOT NULL, terminal boolean NOT NULL, cause text,
    CHECK(deadline_us=arrived_us+${WAIT_US})
  )`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, directory, input, failAt] = process.argv.slice(2);
  if (action === "initialize") initialize(`${directory}/ingress.sqlite`);
  else if (action === "serve") serve(directory);
  else if (action === "import") {
    // The parent probe supplies authoritative, read-only FS discovery evidence.
    const records = JSON.parse(readFileSync(input, "utf8"));
    const client = new pg.Client({ host: `${directory}/socket`, user: "postgres", database: "a03" });
    await client.connect();
    try {
      const journal = openJournal(`${directory}/ingress.sqlite`);
      try {
        for (const { row, live } of records) {
          const terminal = await importRecord(client, row, live, failAt);
          // Live evidence remains reserved even after import, until terminal import.
          journal
            .prepare(
              "UPDATE ingress SET ack=?, state=CASE WHEN ? THEN 2 ELSE state END WHERE uuid=? AND state<>0"
            )
            .run(terminal ? 1 : 0, terminal ? 1 : 0, row.uuid);
        }
      } finally {
        journal.close();
      }
      writeFileSync(`${input}.result`, "committed and acknowledged\n");
    } finally {
      await client.end();
    }
  } else throw new Error("Usage: a03-ingress-journal.mjs initialize|import DIRECTORY [INPUT] [FAIL_AT]");
}
