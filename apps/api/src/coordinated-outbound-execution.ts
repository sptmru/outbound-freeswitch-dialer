import type pg from "pg";
import type { AppConfig } from "./config.js";
import type { CallExecutor, CommandResolution, DurableCommand } from "./call-executor.js";
import { createCommandDriver, type BackgroundJobEvidence } from "./call-command-transport.js";
import { deskTelephony, verifiedDeskContact } from "./desk-sessions.js";
import { buildAgentBridgeOriginateCommand } from "./esl.js";
import { ingressUuid } from "./ingress-journal.js";
import { manualOutboundExecutor } from "./manual-outbound.js";

export async function persistCoordinatedOutboundJob(db: pg.Pool | pg.PoolClient, job: BackgroundJobEvidence) {
  if (!ingressUuid.test(job.jobUuid)) return false;
  return Boolean(
    (
      await db.query(
        `insert into call_events(call_id,event_type,freeswitch_event_name,raw_json)
        select call_id,'coordinated_outbound_job','BACKGROUND_JOB',$2 from call_operations
        where command_uuid=$1 and command_kind='originate' and request ? 'admission'`,
        [job.jobUuid, { jobUuid: job.jobUuid, body: job.body.trim().slice(0, 4096) }]
      )
    ).rowCount
  );
}

export function outboundJobResolution(op: DurableCommand, body: string): CommandResolution | null {
  const result = body.trim();
  if (op.target_uuid && result === `+OK ${op.target_uuid}`)
    return {
      state: "succeeded",
      result: { jobUuid: op.command_uuid },
      evidence: "exact originate job and agent UUID"
    };
  // The fenced wrapper's own errors are ambiguous. A completed native
  // originate failure uses the FreeSWITCH hangup cause, in upper case.
  if (/^-ERR [A-Z][A-Z0-9_]+$/.test(result))
    return { state: "failed", result: { cause: result.slice(5) }, evidence: "exact originate job failure" };
  return null;
}

export function coordinatedOutboundExecutor(config: AppConfig, executor: CallExecutor) {
  const telephony = deskTelephony(config);
  const driver = createCommandDriver({
    host: config.FREESWITCH_ESL_HOST,
    port: config.FREESWITCH_ESL_PORT,
    password: config.FREESWITCH_ESL_PASSWORD,
    fenced: true,
    buildCommand: (op) =>
      buildAgentBridgeOriginateCommand(config, {
        agentLegUuid: String(op.target_uuid),
        callerId: typeof op.request.callerId === "string" ? op.request.callerId : null,
        callId: op.call_id,
        customerLegUuid: String(op.request.customerUuid),
        destinationNumber: String(op.request.destinationNumber),
        sipUsername: String(op.request.sipUsername),
        serviceOperation: op
      }),
    async verify(op, job, signal, db) {
      if (signal.aborted) return null;
      await persistCoordinatedOutboundJob(db, job);
      return outboundJobResolution(op, job.body);
    },
    async reconcile(op, _signal, db) {
      const jobs = await db.query<{ body: string }>(
        `select distinct raw_json->>'body' as body from call_events
        where call_id=$1 and event_type='coordinated_outbound_job' and raw_json->>'jobUuid'=$2`,
        [op.call_id, op.command_uuid]
      );
      return jobs.rows.length === 1 ? outboundJobResolution(op, jobs.rows[0]!.body) : null;
    }
  });
  const send = driver.send.bind(driver);
  driver.send = async (op, signal, db) => {
    const username = String(op.request.sipUsername);
    const endpoint = verifiedDeskContact(await telephony.lookup(username), username);
    if (signal.aborted) return null;
    if (!endpoint || endpoint !== op.request.endpoint)
      return {
        state: "failed",
        result: { notSent: true },
        evidence: "verified Desk endpoint changed before originate"
      };
    return send(op, signal, db);
  };
  return manualOutboundExecutor(executor, driver);
}
