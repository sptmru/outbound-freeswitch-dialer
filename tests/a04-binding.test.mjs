import assert from "node:assert/strict";
import test from "node:test";
import { uniqueEndpoint, verify, accepts } from "../scripts/a04-binding.mjs";
import { digest, parse } from "../scripts/a04-sip-client.mjs";

test("A04 routing rejects ambiguity, missing registrations, foreign identities and dial-string injection", () => {
  const endpoint = "sofia/a04-loopback/sip:desk_a@127.0.0.2:40000";
  assert.equal(uniqueEndpoint(endpoint, "desk_a"), endpoint);
  for (const value of [
    "error/user_not_registered",
    `${endpoint},${endpoint}`,
    `${endpoint}|${endpoint}`,
    `${endpoint} &park()`,
    endpoint.replace("desk_a", "desk_b"),
    endpoint.replace("127.0.0.2", "203.0.113.1"),
    "user/desk_a@a04.invalid",
    `${endpoint}\noriginate user/x &park()`
  ]) {
    assert.equal(uniqueEndpoint(value, "desk_a"), null);
  }
  assert.throws(() => uniqueEndpoint(endpoint, "desk_a &park()"));
});

test("A04 failed authoritative lookup revokes readiness; old verifier cannot publish readiness", async () => {
  const statements = [];
  const db = {
    query: async (sql, args) => {
      statements.push({ sql, args });
      return { rows: [] };
    }
  };
  const binding = { username: "desk_a", generation: 1, session: "tab_a" };
  assert.equal(
    await verify(db, binding, async () => {
      throw new Error("ESL disconnected");
    }),
    null
  );
  assert.deepEqual(statements[0].args, [null, 1, "tab_a", "desk_a"]);
  assert.match(statements[0].sql, /generation=\$2 AND session=\$3 AND username=\$4 AND expires>now\(\)/);
});

test("A04 service INVITE requires current session, generation and reserved operation", async () => {
  const row = {
    username: "desk_a",
    session: "tab_a",
    generation: 2,
    operation: "operation-1",
    ready: true,
    slot: "reserved",
    expires: new Date(Date.now() + 60000)
  };
  const db = { query: async () => ({ rows: [row] }) };
  const binding = { ...row };
  const headers = { "x-a04-session": "tab_a", "x-a04-generation": "2", "x-a04-operation": "operation-1" };
  assert.equal(await accepts(db, binding, headers), true);
  for (const changes of [
    { "x-a04-session": "old" },
    { "x-a04-generation": "1" },
    { "x-a04-operation": "other" }
  ])
    assert.equal(await accepts(db, binding, { ...headers, ...changes }), false);
  row.slot = "idle";
  assert.equal(await accepts(db, binding, headers), false);
  row.slot = "active";
  row.expires = new Date(0);
  assert.equal(await accepts(db, binding, headers), false);
});

test("A04 real SIP fixture parses challenge and rejects unsupported Digest algorithms", () => {
  const parsed = parse(
    'SIP/2.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm="lab", nonce="nonce", qop="auth"\r\nContent-Length: 0\r\n\r\n'
  );
  const auth = digest(parsed.headers["www-authenticate"], "desk_a", "fixture", "sip:a04.invalid");
  assert.match(auth, /qop=auth, nc=00000001/);
  assert.match(auth, /response="[0-9a-f]{32}"/);
  assert.throws(() => digest('Digest realm="lab",nonce="nonce",algorithm=SHA-256', "a", "b", "sip:lab"));
  assert.throws(() => digest('Digest realm="lab",nonce="nonce",qop="auth-int"', "a", "b", "sip:lab"));
});
