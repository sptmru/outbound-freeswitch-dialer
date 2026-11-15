// Cross-process C01 SQL participant. No ESL transport is available to this worker.
import pg from "pg";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { databaseConfig, testDatabaseUrl } from "./database.mjs";
import { withCallAdmission } from "../../../apps/api/dist-test/call-admission.js";
const lifetime = setTimeout(() => process.exit(1), 15000);
lifetime.unref();
process.once("disconnect", () => process.exit(1));
const [schema, raw] = process.argv.slice(2);
const input = JSON.parse(raw);
const pool = new pg.Pool(databaseConfig(testDatabaseUrl(), schema));
const client = await pool.connect();
const signal = async (type, extra = {}) =>
  new Promise((resolve, reject) =>
    process.send({ type, ...extra }, (error) => (error ? reject(error) : resolve()))
  );
try {
  await signal("ready", {
    pid: process.pid,
    backend: (await client.query("select pg_backend_pid() as pid")).rows[0].pid
  });
  await once(process, "message");
  try {
    const token = await withCallAdmission(
      client,
      {
        agentIds: [input.agentId],
        callIds: [input.callId],
        campaignIds: [input.campaignId],
        startsCall: true
      },
      async (admission) => {
        const decision = await admission.eligibility(input);
        if (!decision.eligible) throw new Error(decision.reason);
        let offerId;
        if (input.inbound) {
          offerId = (
            await client.query(
              `insert into call_offers(call_id,agent_id,kind,attempt,desk_session_id,desk_revision,binding_generation,deadline_at)
          values($1,$2,'inbound',1,$3,1,1,clock_timestamp()+interval '20 seconds') returning id`,
              [input.callId, input.agentId, input.deskSessionId]
            )
          ).rows[0].id;
        }
        const token = await admission.reserve({ ...input, offerId }, input.callId);
        if (offerId)
          await client.query(
            "update call_offers set state='accepted',reason='explicit_accept',closed_at=clock_timestamp() where id=$1",
            [offerId]
          );
        await client.query(
          `insert into call_operations(call_id,idempotency_scope,idempotency_key,request_fingerprint,command_kind,generation,command_uuid,deadline_at)
        values($1,$2,$3,$4,'originate',$5,$6,clock_timestamp()+interval '10 seconds')`,
          [input.callId, `agent:${input.agentId}`, input.key, "a".repeat(64), token.generation, randomUUID()]
        );
        const command = once(process, "message");
        await signal("before-commit", { token });
        const [message] = await command;
        if (message.type === "rollback") throw new Error("fixture_rollback");
        return token;
      }
    );
    await signal("committed", { token });
  } catch (error) {
    await signal("rejected", { reason: error.reason ?? error.message });
  }
} finally {
  client.release();
  await pool.end();
  clearTimeout(lifetime);
  process.removeAllListeners("disconnect");
  process.disconnect();
}
