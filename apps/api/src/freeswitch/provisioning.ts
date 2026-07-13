import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { decryptSecret } from "../auth/crypto.js";
import { sendFreeSwitchApiCommand } from "../esl.js";

const AGENT_SIP_PROFILE = "internal-webrtc";

export interface AgentRegistrationRefreshResult {
  commands: string[];
  errors: Array<{ command: string; message: string }>;
  skipped: boolean;
}

export type FreeSwitchApiSender = (config: AppConfig, command: string) => Promise<unknown>;

interface AgentDirectoryRecord {
  sip_username: string;
  sip_password_encrypted: string;
  display_name: string;
}

interface AgentDirectoryReconciliationLogger {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
}

export async function provisionAgentDirectory(
  config: AppConfig,
  agent: { sipUsername: string; sipPassword: string; displayName: string }
): Promise<void> {
  const directory = agentDirectoryPath(config);
  await mkdir(directory, { recursive: true });
  await writeFile(
    agentDirectoryXmlPath(config, agent.sipUsername),
    renderAgentDirectoryXml(config, agent),
    "utf8"
  );
}

export async function ensureAgentDirectory(
  config: AppConfig,
  agent: { sipUsername: string; sipPassword: string; displayName: string }
): Promise<void> {
  try {
    await stat(agentDirectoryXmlPath(config, agent.sipUsername));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
    await provisionAgentDirectory(config, agent);
  }
}

export async function deleteAgentDirectory(config: AppConfig, sipUsername: string): Promise<void> {
  await rm(agentDirectoryXmlPath(config, sipUsername), { force: true });
}

export async function refreshDeletedAgentRegistrations(
  config: AppConfig,
  sipUsernames: string[],
  sendApiCommand: FreeSwitchApiSender = sendFreeSwitchApiCommand
): Promise<AgentRegistrationRefreshResult> {
  const uniqueSipUsernames = Array.from(new Set(sipUsernames)).filter(Boolean);
  if (!config.FREESWITCH_ESL_ENABLED || !uniqueSipUsernames.length) {
    return { commands: [], errors: [], skipped: true };
  }

  const commands = [
    "reloadxml",
    ...uniqueSipUsernames.map((sipUsername) => buildFlushInboundRegistrationCommand(config, sipUsername))
  ];
  const errors: AgentRegistrationRefreshResult["errors"] = [];

  for (const command of commands) {
    try {
      await sendApiCommand(config, command);
    } catch (error) {
      errors.push({
        command,
        message: error instanceof Error ? error.message : "FreeSWITCH command failed"
      });
    }
  }

  return { commands, errors, skipped: false };
}

export async function provisionAllAgentDirectories(pool: pg.Pool, config: AppConfig): Promise<number> {
  const result = await pool.query<AgentDirectoryRecord>(
    `
      select sip_username, sip_password_encrypted, display_name
      from agents
      join users on users.id = agents.user_id
      where users.is_active = true
      order by agents.created_at asc
    `
  );

  for (const agent of result.rows) {
    await provisionAgentDirectory(config, {
      sipUsername: agent.sip_username,
      sipPassword: decryptSecret(config, agent.sip_password_encrypted),
      displayName: agent.display_name
    });
  }

  return result.rowCount ?? 0;
}

export async function reconcileAgentDirectories(
  pool: pg.Pool,
  config: AppConfig
): Promise<{ provisioned: number; removed: number; refreshErrors: number }> {
  const provisioned = await provisionAllAgentDirectories(pool, config);
  const inactive = await pool.query<{ sip_username: string }>(
    `
      select agents.sip_username
      from agents
      join users on users.id = agents.user_id
      where users.is_active = false
      order by agents.created_at asc
    `
  );
  const removedUsernames: string[] = [];
  for (const agent of inactive.rows) {
    await deleteAgentDirectory(config, agent.sip_username);
    removedUsernames.push(agent.sip_username);
  }
  const refresh = await refreshDeletedAgentRegistrations(config, removedUsernames);
  return {
    provisioned,
    removed: removedUsernames.length,
    refreshErrors: refresh.errors.length
  };
}

export function startAgentDirectoryReconciler(
  pool: pg.Pool,
  config: AppConfig,
  logger: AgentDirectoryReconciliationLogger,
  intervalMilliseconds = 60_000
): () => void {
  let stopped = false;
  let running = false;
  const reconcile = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await reconcileAgentDirectories(pool, config);
      if (result.removed || result.refreshErrors) {
        logger.info(result, "FreeSWITCH agent directory reconciliation completed");
      }
    } catch (error) {
      logger.warn(
        { message: error instanceof Error ? error.message : String(error) },
        "FreeSWITCH agent directory reconciliation failed; it will retry"
      );
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void reconcile(), intervalMilliseconds);
  interval.unref();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function agentDirectoryPath(config: AppConfig): string {
  return join(config.FREESWITCH_GENERATED_CONFIG_DIR, "directory", "default");
}

function agentDirectoryXmlPath(config: AppConfig, sipUsername: string): string {
  return join(agentDirectoryPath(config), `${safeFilename(sipUsername)}.xml`);
}

function buildFlushInboundRegistrationCommand(config: AppConfig, sipUsername: string): string {
  const userAddress = `${assertFreeSwitchApiArgument(sipUsername, "SIP username")}@${assertFreeSwitchApiArgument(
    config.FREESWITCH_DOMAIN,
    "FreeSWITCH domain"
  )}`;
  return `sofia profile ${AGENT_SIP_PROFILE} flush_inbound_reg ${userAddress}`;
}

function renderAgentDirectoryXml(
  config: AppConfig,
  agent: { sipUsername: string; sipPassword: string; displayName: string }
): string {
  return `<include>
  <user id="${escapeXml(agent.sipUsername)}">
    <params>
      <param name="password" value="${escapeXml(agent.sipPassword)}"/>
      <param name="vm-password" value="${escapeXml(agent.sipPassword)}"/>
    </params>
    <variables>
      <variable name="user_context" value="agent-ingress"/>
      <variable name="effective_caller_id_name" value="${escapeXml(agent.displayName)}"/>
      <variable name="effective_caller_id_number" value="${escapeXml(agent.sipUsername)}"/>
      <variable name="domain_name" value="${escapeXml(config.FREESWITCH_DOMAIN)}"/>
    </variables>
  </user>
</include>
`;
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function assertFreeSwitchApiArgument(value: string, label: string): string {
  if (/\s/.test(value)) {
    throw new Error(`${label} contains whitespace and cannot be used in a FreeSWITCH API command`);
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
