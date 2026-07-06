import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { decryptSecret } from "../auth/crypto.js";

interface AgentDirectoryRecord {
  sip_username: string;
  sip_password_encrypted: string;
  display_name: string;
}

export async function provisionAgentDirectory(
  config: AppConfig,
  agent: { sipUsername: string; sipPassword: string; displayName: string }
): Promise<void> {
  const directory = join(config.FREESWITCH_GENERATED_CONFIG_DIR, "directory", "default");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${safeFilename(agent.sipUsername)}.xml`),
    renderAgentDirectoryXml(config, agent),
    "utf8"
  );
}

export async function provisionAllAgentDirectories(pool: pg.Pool, config: AppConfig): Promise<number> {
  const result = await pool.query<AgentDirectoryRecord>(
    `
      select sip_username, sip_password_encrypted, display_name
      from agents
      order by created_at asc
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
      <variable name="user_context" value="default"/>
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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
