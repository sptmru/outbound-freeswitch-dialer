import type pg from "pg";
import type { AppConfig } from "./config.js";
import { sendFreeSwitchApiCommand } from "./esl.js";

interface Logger {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
}

type FreeSwitchApiCommandSender = typeof sendFreeSwitchApiCommand;

const REGISTRATION_RECONCILE_INTERVAL_MS = 5_000;
const AGENT_SIP_PROFILE = "internal-webrtc";

export function startAgentRegistrationReconciler(
  config: AppConfig,
  pool: pg.Pool,
  logger: Logger
): () => void {
  if (!config.FREESWITCH_ESL_ENABLED) {
    return () => undefined;
  }

  let running = false;
  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const changedAgents = await reconcileAgentRegistrations(config, pool);
      if (changedAgents > 0) {
        logger.info({ changedAgents }, "FreeSWITCH agent registration state reconciled");
      }
    } catch (error) {
      logger.warn(
        { message: error instanceof Error ? error.message : String(error) },
        "FreeSWITCH agent registration reconciliation failed"
      );
    } finally {
      running = false;
    }
  };

  void run();
  const interval = setInterval(() => void run(), REGISTRATION_RECONCILE_INTERVAL_MS);
  interval.unref();

  return () => clearInterval(interval);
}

export async function reconcileAgentRegistrations(
  config: AppConfig,
  pool: pg.Pool,
  sendApiCommand: FreeSwitchApiCommandSender = sendFreeSwitchApiCommand
): Promise<number> {
  try {
    const response = await sendApiCommand(config, `sofia status profile ${AGENT_SIP_PROFILE} reg`);
    const registeredUsernames = parseRegisteredSipUsernames(response.body || response.raw);
    const databaseRegistrations = await pool.query<{ sip_username: string }>(
      "select sip_username from agents where registered = true order by sip_username"
    );
    const databaseUsernames = databaseRegistrations.rows.map((row) => row.sip_username);
    const driftCount = symmetricDifferenceSize(databaseUsernames, registeredUsernames);
    const result = await pool.query(
      `
        update agents
        set registered = sip_username = any($1::text[]),
            last_registered_at = case
              when not registered and sip_username = any($1::text[]) then now()
              else last_registered_at
            end,
            last_unregistered_at = case
              when registered and not (sip_username = any($1::text[])) then now()
              else last_unregistered_at
            end,
            status = case
              when sip_username = any($1::text[]) and status = 'offline' then 'ready'
              when not (sip_username = any($1::text[]))
                and status in ('ready', 'registered')
                and not exists (
                  select 1
                  from calls
                  where calls.agent_id = agents.id
                    and calls.ended_at is null
                    and calls.state not in ('completed', 'failed', 'canceled')
                )
                then 'offline'
              else status
            end,
            updated_at = now()
        where registered is distinct from (sip_username = any($1::text[]))
           or (sip_username = any($1::text[]) and status = 'offline')
           or (
             not (sip_username = any($1::text[]))
             and status in ('ready', 'registered')
             and not exists (
               select 1
               from calls
               where calls.agent_id = agents.id
                 and calls.ended_at is null
                 and calls.state not in ('completed', 'failed', 'canceled')
             )
           )
      `,
      [registeredUsernames]
    );
    const changedAgents = result.rowCount ?? 0;
    await pool.query(
      `
        insert into telephony_observability_state (
          singleton,
          registration_db_count,
          registration_freeswitch_count,
          registration_drift_count,
          registration_corrections_last_run,
          registration_reconcile_status,
          registration_reconciled_at,
          updated_at
        )
        values (true, $1, $2, $3, $4, 'ok', clock_timestamp(), now())
        on conflict (singleton) do update
        set registration_db_count = excluded.registration_db_count,
            registration_freeswitch_count = excluded.registration_freeswitch_count,
            registration_drift_count = excluded.registration_drift_count,
            registration_corrections_last_run = excluded.registration_corrections_last_run,
            registration_reconcile_status = excluded.registration_reconcile_status,
            registration_reconciled_at = excluded.registration_reconciled_at,
            updated_at = now()
      `,
      [databaseUsernames.length, registeredUsernames.length, driftCount, changedAgents]
    );
    return changedAgents;
  } catch (error) {
    await pool
      .query(
        `
          insert into telephony_observability_state (
            singleton,
            registration_reconcile_status,
            updated_at
          )
          values (true, 'failed', now())
          on conflict (singleton) do update
          set registration_reconcile_status = excluded.registration_reconcile_status,
              updated_at = now()
        `
      )
      .catch(() => undefined);
    throw error;
  }
}

function symmetricDifferenceSize(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let difference = 0;
  for (const value of leftSet) {
    if (!rightSet.has(value)) difference += 1;
  }
  for (const value of rightSet) {
    if (!leftSet.has(value)) difference += 1;
  }
  return difference;
}

export function parseRegisteredSipUsernames(value: string): string[] {
  const usernames = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:User|Auth-User):\s*([^\s@<>]+)(?:@[^\s<>]+)?\s*$/i);
    if (match?.[1]) {
      usernames.add(match[1]);
    }
  }
  return [...usernames];
}

export const __testing = {
  parseRegisteredSipUsernames,
  symmetricDifferenceSize
};
