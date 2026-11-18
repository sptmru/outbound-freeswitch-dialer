import type pg from "pg";
import type { CallExecutor } from "./call-executor.js";
import type { AppConfig } from "./config.js";
import { createLifecycleRecovery } from "./inbound-recovery.js";
import { createInboundQueueCoordinator } from "./inbound-queue.js";
import { inboundConnectionExecutor } from "./inbound-connection.js";
import { transferConnectionExecutor } from "./transfer-connection.js";
import { inboundFallbackExecutor } from "./inbound-fallback.js";
import { nativeCallControlExecutor } from "./native-call-control.js";
import { recoveryCleanupExecutor } from "./recovery-cleanup.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import type { ForwardingConfig } from "./inbound-forwarding.js";

/** Explicit staged composition. No pool, role, timer or feature flag is created.
 * I05 must supply the reserved executor and compatible FS scripts before wiring
 * this consumer into the actual listener. Every new sender uses fs-fenced-v1.
 */
export function lifecycleRecoveryRuntime(
  pool: pg.Pool,
  executor: CallExecutor,
  socket: string,
  endpoint: { host: string; port: number; password: string },
  forwarding?: ForwardingConfig
) {
  const esl = { ...endpoint, fenced: true };
  const config = {
    FREESWITCH_ESL_HOST: esl.host,
    FREESWITCH_ESL_PORT: esl.port,
    FREESWITCH_ESL_PASSWORD: esl.password
  } as AppConfig;
  const command = async (text: string) => (await sendFreeSwitchApiCommand(config, text, 1000)).body.trim();
  return createLifecycleRecovery(
    pool,
    executor,
    {
      ingress: createInboundQueueCoordinator(pool, socket, command, executor, esl),
      connection: inboundConnectionExecutor(pool, executor, esl),
      transfer: transferConnectionExecutor(pool, executor, esl),
      fallback: inboundFallbackExecutor(pool, executor, esl, forwarding),
      control: nativeCallControlExecutor(pool, executor, esl),
      cleanup: recoveryCleanupExecutor(pool, executor, esl, command)
    },
    command
  );
}
