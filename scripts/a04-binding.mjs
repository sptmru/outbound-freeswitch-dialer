// A04 decision prototype only. No product schema, routes or environment fallback.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const OCCUPIED = ["reserved", "connecting", "active", "releasing", "uncertain"];

export async function schema(db) {
  await db.query(`
    CREATE TABLE a04_desk (
      agent integer PRIMARY KEY, generation integer NOT NULL DEFAULT 0,
      session text, username text, endpoint text, operation uuid, ready boolean NOT NULL DEFAULT false,
      expires timestamptz NOT NULL DEFAULT now(),
      slot text NOT NULL DEFAULT 'idle'
        CHECK (slot IN ('idle','reserved','connecting','active','releasing','uncertain'))
    );
    CREATE TABLE a04_bindings (
      username text PRIMARY KEY, generation integer UNIQUE NOT NULL,
      session text NOT NULL, revoked boolean NOT NULL DEFAULT false,
      cleanup_due timestamptz, cleaned boolean NOT NULL DEFAULT false
    );
    INSERT INTO a04_desk(agent) VALUES (1);
  `);
}

export async function takeover(pool, session, username, afterLock = async () => {}) {
  assert.match(session, /^[a-z0-9_]+$/);
  assert.match(username, /^desk_[a-z0-9_]+$/);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const {
      rows: [old]
    } = await db.query("SELECT * FROM a04_desk WHERE agent=1 FOR UPDATE");
    assert.equal(old.slot, "idle", `Takeover refused: ${old.slot}`);
    await afterLock();
    await db.query(
      `UPDATE a04_bindings SET revoked=true, cleanup_due=now()+interval '5 seconds'
      WHERE username=$1`,
      [old.username]
    );
    const generation = old.generation + 1;
    await db.query("INSERT INTO a04_bindings(username,generation,session) VALUES($1,$2,$3)", [
      username,
      generation,
      session
    ]);
    const {
      rows: [row]
    } = await db.query(
      `UPDATE a04_desk SET generation=$1,session=$2,
      username=$3,endpoint=NULL,ready=false,expires=now()+interval '30 seconds'
      WHERE agent=1 RETURNING *`,
      [generation, session, username]
    );
    await db.query("COMMIT");
    return row;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

// Only exact loopback addresses from the fixture's authoritative FS lookup are accepted.
// No destination parameter from a browser is accepted by verify() or reserve().
export function uniqueEndpoint(value, username) {
  assert.match(username, /^desk_[a-z0-9_]+$/);
  const pattern = new RegExp(
    `^sofia/a04-loopback/sip:${username}@127\\.0\\.0\\.[234]:[0-9]+(?:;[a-zA-Z0-9_=.-]+)*$`
  );
  return pattern.test(value.trim()) ? value.trim() : null;
}

export async function verify(pool, binding, lookup, beforeCommit = async () => {}) {
  let endpoint = null;
  try {
    endpoint = uniqueEndpoint(await lookup(binding.username), binding.username);
  } catch {
    /* fail closed */
  }
  await beforeCommit();
  const result = await pool.query(
    `UPDATE a04_desk SET endpoint=COALESCE(endpoint,$1),
      ready=($1::text IS NOT NULL AND (endpoint IS NULL OR endpoint=$1))
    WHERE agent=1 AND generation=$2 AND session=$3 AND username=$4 AND expires>now()
    RETURNING *`,
    [endpoint, binding.generation, binding.session, binding.username]
  );
  return result.rows[0] ?? null;
}

export async function heartbeat(pool, binding, close = false) {
  return pool.query(
    `UPDATE a04_desk SET expires=now()+interval '30 seconds',
    ready=CASE WHEN $3 THEN false ELSE ready END
    WHERE agent=1 AND generation=$1 AND session=$2 RETURNING *`,
    [binding.generation, binding.session, close]
  );
}

export async function reserve(pool, binding) {
  const result = await pool.query(
    `UPDATE a04_desk SET slot='reserved',operation=$3
    WHERE agent=1 AND generation=$1 AND session=$2 AND ready AND expires>now()
      AND endpoint IS NOT NULL AND slot='idle' RETURNING *`,
    [binding.generation, binding.session, randomUUID()]
  );
  assert.equal(result.rowCount, 1, "Binding unavailable or slot occupied");
  return result.rows[0];
}

export async function accepts(pool, binding, headers) {
  const {
    rows: [row]
  } = await pool.query("SELECT * FROM a04_desk WHERE agent=1");
  return (
    row.ready &&
    row.generation === binding.generation &&
    row.session === binding.session &&
    row.username === binding.username &&
    row.expires > new Date() &&
    headers["x-a04-session"] === row.session &&
    headers["x-a04-generation"] === String(row.generation) &&
    headers["x-a04-operation"] === row.operation &&
    OCCUPIED.includes(row.slot)
  );
}
