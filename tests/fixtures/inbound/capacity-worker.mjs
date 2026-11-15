// C02 participant: real SQL, simulated command ledger; no ESL/SIP transport.
import pg from "pg";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { databaseConfig, testDatabaseUrl } from "./database.mjs";
import { withCallAdmission } from "../../../apps/api/dist-test/call-admission.js";
const [schema, raw] = process.argv.slice(2);
const input = JSON.parse(raw);
const timer = setTimeout(() => process.exit(1), 15000);
process.once("disconnect", () => process.exit(1));
const pool = new pg.Pool(databaseConfig(testDatabaseUrl(), schema));
const client = await pool.connect();
const signal = (type, extra = {}) =>
  new Promise((resolve, reject) => process.send({ type, ...extra }, (e) => (e ? reject(e) : resolve())));
try {
  await signal("ready", {
    pid: process.pid,
    backend: (await client.query("select pg_backend_pid() as pid")).rows[0].pid
  });
  await once(process, "message");
  try {
    const result = await withCallAdmission(
      client,
      { callIds: [input.callId], agentIds: input.agentId ? [input.agentId] : [], startsCall: true },
      async (a) => {
        await client.query(
          `insert into call_operations(id,call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,generation,command_uuid,deadline_at)
        values($1,$2,'c02',$1::uuid::text,$3,'originate',$4,$5,clock_timestamp()+interval '10 seconds')`,
          [input.operationId, input.callId, "a".repeat(64), input.generation, randomUUID()]
        );
        const result = await a.capacity.claim(input);
        const next = once(process, "message");
        await signal("claimed", { result });
        const [message] = await next;
        if (message.type === "rollback") throw new Error("fixture_rollback");
        return result;
      }
    );
    await signal("committed", { result });
    // A fake sender verifies durable reservations before recording its sole send.
    const rows = (
      await client.query(
        "select id from call_capacity_reservations where operation_id=$1 and state<>'released'",
        [input.operationId]
      )
    ).rows;
    if (rows.length !== result.tokens.length) throw new Error("unreserved_send");
    await client.query("insert into capacity_command_ledger(operation_id,reservation_ids) values($1,$2)", [
      input.operationId,
      rows.map((r) => r.id)
    ]);
    await signal("sent");
  } catch (e) {
    await signal("rejected", { reason: e.reason ?? e.message, resource: e.resource });
  }
} finally {
  client.release();
  await pool.end();
  clearTimeout(timer);
  process.removeAllListeners("disconnect");
  process.disconnect();
}
