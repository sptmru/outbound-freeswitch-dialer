import type pg from "pg";
import { CallExecutor } from "./call-executor.js";
import { CAPACITY_SETTINGS_KEY, defaultCapacityLimits, validateCapacityLimits } from "./call-capacity.js";
import { commandJournalPath } from "./command-recovery.js";
import type { AppConfig } from "./config.js";
import { coordinatedOutboundExecutor } from "./coordinated-outbound-execution.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import { inboundPolicy, validateInboundPolicy } from "./freeswitch/inbound-config.js";
import { inboundConnectionExecutor } from "./inbound-connection.js";
import { startInboundOfferDispatcher } from "./inbound-dispatcher.js";
import { ingressRequest } from "./ingress-agent.js";
import { ingressUuid } from "./ingress-journal.js";
import { lifecycleRecoveryRuntime } from "./lifecycle-recovery-runtime.js";
import { nativeCallControlExecutor } from "./native-call-control.js";
import { supervisorExecutor } from "./supervisor-coordination.js";
import { transferConnectionExecutor } from "./transfer-connection.js";

export async function checkCoordinationConfiguration(pool: pg.Pool, config: AppConfig) {
  if (
    !config.FREESWITCH_ESL_ENABLED ||
    !config.FREESWITCH_INGRESS_ENABLED ||
    !config.FREESWITCH_INBOUND_CONFIG_ENABLED ||
    !config.CALL_EXECUTOR_DATABASE_URL
  )
    throw new Error(
      "Call coordination requires ESL, ingress, inbound configuration and CALL_EXECUTOR_DATABASE_URL"
    );
  validateInboundPolicy(inboundPolicy(config));
  let database: URL;
  let executorDatabase: URL;
  try {
    database = new URL(config.DATABASE_URL);
    executorDatabase = new URL(config.CALL_EXECUTOR_DATABASE_URL);
  } catch {
    throw new Error("Call coordination requires valid application and executor PostgreSQL URLs");
  }
  const authority = (value: URL) => `${value.hostname}:${value.port || "5432"}${value.pathname}`;
  if (
    !["postgres:", "postgresql:"].includes(executorDatabase.protocol) ||
    authority(database) !== authority(executorDatabase) ||
    database.username === executorDatabase.username
  )
    throw new Error("Call coordination requires a separate executor role on the application database");
  const {
    rows: [settings]
  } = await pool.query<{ value_json: unknown }>("select value_json from system_settings where key=$1", [
    CAPACITY_SETTINGS_KEY
  ]);
  const limits = settings ? validateCapacityLimits(settings.value_json) : defaultCapacityLimits;
  if (
    limits.channels + config.FREESWITCH_INBOUND_PRE_ADMISSION_LIMIT > config.FREESWITCH_MAX_SESSIONS ||
    limits.trunk + config.FREESWITCH_INBOUND_PRE_ADMISSION_LIMIT > config.FREESWITCH_TRUNK_CHANNEL_LIMIT
  )
    throw new Error("Call coordination capacity limits exceed the FreeSWITCH channel or trunk headroom");
}

export async function checkCoordinationDependencies(pool: pg.Pool, config: AppConfig) {
  await checkCoordinationConfiguration(pool, config);
  const command = async (value: string) => (await sendFreeSwitchApiCommand(config, value, 1000)).body.trim();
  const script = await commandJournalPath(command);
  if (!ingressUuid.test(await command(`lua ${script} boot`))) {
    throw new Error("FreeSWITCH native command journal is unavailable");
  }
  const journal = JSON.parse(await ingressRequest(config.FREESWITCH_INGRESS_SOCKET, "/status"));
  if (!ingressUuid.test(journal.journalId ?? "")) {
    throw new Error("Ingress journal identity is unavailable");
  }
  return command;
}

export async function createCallCoordinationRuntime(pool: pg.Pool, config: AppConfig) {
  const {
    rows: [marker]
  } = await pool.query<{ ready: boolean }>(
    "select not reconciliation_required and reconciled_at is not null as ready from call_admission_migration"
  );
  if (Boolean(marker?.ready) !== config.CALL_COORDINATION_ENABLED) {
    throw new Error("Call coordination configuration and the admission cutover marker disagree");
  }
  if (!config.CALL_COORDINATION_ENABLED) return null;

  const command = await checkCoordinationDependencies(pool, config);
  const executor = await CallExecutor.create({ connectionString: config.CALL_EXECUTOR_DATABASE_URL }, 0);
  try {
    const endpoint = {
      host: config.FREESWITCH_ESL_HOST,
      port: config.FREESWITCH_ESL_PORT,
      password: config.FREESWITCH_ESL_PASSWORD,
      fenced: true
    };
    const outbound = coordinatedOutboundExecutor(config, executor);
    const supervisor = supervisorExecutor(pool, executor, config, endpoint, command);
    return {
      outbound,
      supervisor,
      controls: nativeCallControlExecutor(pool, executor, endpoint),
      connection: inboundConnectionExecutor(pool, executor, endpoint),
      transfer: transferConnectionExecutor(pool, executor, endpoint),
      recovery: lifecycleRecoveryRuntime(pool, executor, config.FREESWITCH_INGRESS_SOCKET, endpoint, config, {
        outbound,
        supervisor
      }),
      startDispatcher: (report: (error: unknown) => void) => startInboundOfferDispatcher(pool, report),
      close: () => executor.close()
    };
  } catch (error) {
    await executor.close();
    throw error;
  }
}
