import net from "node:net";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";

export interface EslCommandResponse {
  body: string;
  headers: Record<string, string>;
  raw: string;
}

export interface OriginateCustomerLegInput {
  callId: string;
  destinationNumber: string;
  legUuid: string;
}

export interface OriginateAgentBridgeCallInput {
  agentLegUuid: string;
  callId: string;
  customerLegUuid: string;
  destinationNumber: string;
  sipUsername: string;
}

export async function checkFreeSwitchEsl(config: AppConfig): Promise<string> {
  if (!config.FREESWITCH_ESL_ENABLED) {
    return "disabled by FREESWITCH_ESL_ENABLED=false";
  }

  await sendFreeSwitchApiCommand(config, "status");
  return `connected to ${config.FREESWITCH_ESL_HOST}:${config.FREESWITCH_ESL_PORT}`;
}

export async function createFreeSwitchUuid(config: AppConfig): Promise<string> {
  void config;
  return randomUUID();
}

export async function originateCustomerLeg(
  config: AppConfig,
  input: OriginateCustomerLegInput
): Promise<{ command: string; jobUuid: string; legUuid: string }> {
  const dialString = buildCustomerDialString(config, input.destinationNumber);
  const variables = [
    `origination_uuid=${input.legUuid}`,
    `outbound_dialer_call_id=${input.callId}`,
    "ignore_early_media=true",
    "originate_timeout=45",
    config.SIP_TRUNK_CALLER_ID
      ? `origination_caller_id_number=${escapeOriginateVariable(config.SIP_TRUNK_CALLER_ID)}`
      : null
  ]
    .filter(Boolean)
    .join(",");
  const command = `originate {${variables}}${dialString} &park()`;
  const response = await sendFreeSwitchBgapiCommand(config, command);
  return {
    command,
    jobUuid: parseJobUuid(response),
    legUuid: input.legUuid
  };
}

export async function originateAgentBridgeCall(
  config: AppConfig,
  input: OriginateAgentBridgeCallInput
): Promise<{ agentLegUuid: string; command: string; customerLegUuid: string; jobUuid: string }> {
  const command = buildAgentBridgeOriginateCommand(config, input);
  const response = await sendFreeSwitchBgapiCommand(config, command);
  return {
    agentLegUuid: input.agentLegUuid,
    command,
    customerLegUuid: input.customerLegUuid,
    jobUuid: parseJobUuid(response)
  };
}

function buildAgentBridgeOriginateCommand(config: AppConfig, input: OriginateAgentBridgeCallInput): string {
  const customerDialString = buildCustomerDialString(config, input.destinationNumber);
  const agentVariables = buildOriginateVariables([
    `origination_uuid=${input.agentLegUuid}`,
    `outbound_dialer_call_id=${input.callId}`,
    "outbound_dialer_leg_type=agent",
    "originate_timeout=30",
    "bridge_early_media=true",
    "instant_ringback=true",
    "hangup_after_bridge=true",
    "continue_on_fail=false"
  ]);
  const customerVariables = buildOriginateVariables([
    `origination_uuid=${input.customerLegUuid}`,
    `outbound_dialer_call_id=${input.callId}`,
    "outbound_dialer_leg_type=customer",
    "ignore_early_media=false",
    "media_bug_answer_req=false",
    "originate_timeout=45",
    config.SIP_TRUNK_CALLER_ID
      ? `origination_caller_id_number=${escapeOriginateVariable(config.SIP_TRUNK_CALLER_ID)}`
      : null
  ]);
  return `originate {${agentVariables}}user/${input.sipUsername}@${config.FREESWITCH_DOMAIN} &bridge({${customerVariables}}${customerDialString})`;
}

export function canOriginateCustomerLeg(config: AppConfig): boolean {
  if (!config.FREESWITCH_ESL_ENABLED) {
    return false;
  }
  if (config.SIP_TRUNK_MODE === "ip_auth") {
    return Boolean(config.SIP_TRUNK_PROXY);
  }
  return Boolean(config.SIP_TRUNK_PROXY && config.SIP_TRUNK_USERNAME);
}

export async function sendFreeSwitchApiCommand(config: AppConfig, command: string): Promise<EslCommandResponse> {
  return sendFreeSwitchCommand(config, `api ${command}`);
}

export async function sendFreeSwitchBgapiCommand(config: AppConfig, command: string): Promise<EslCommandResponse> {
  return sendFreeSwitchCommand(config, `api bgapi ${command}`);
}

async function sendFreeSwitchCommand(config: AppConfig, command: string): Promise<EslCommandResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: config.FREESWITCH_ESL_HOST,
      port: config.FREESWITCH_ESL_PORT,
      timeout: 5000
    });
    let stage: "auth" | "connect" | "command" = "auth";
    let buffer = "";
    let authSent = false;

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      if (stage === "auth" && !authSent && buffer.includes("Content-Type: auth/request")) {
        authSent = true;
        socket.write(`auth ${config.FREESWITCH_ESL_PASSWORD}\n\n`);
      }

      if (stage === "auth" && buffer.includes("+OK accepted")) {
        stage = "connect";
        buffer = "";
        socket.write("connect\n\n");
        return;
      }

      if (stage === "connect" && parseEslResponse(buffer)) {
        stage = "command";
        buffer = "";
        socket.write(`${command}\n\n`);
        return;
      }

      if (stage === "command") {
        const parsed = parseEslResponse(buffer);
        if (!parsed) {
          return;
        }
        cleanup();
        if (parsed.body.startsWith("-ERR") || parsed.headers["reply-text"]?.startsWith("-ERR")) {
          reject(new Error(parsed.body || parsed.headers["reply-text"] || "FreeSWITCH command failed"));
          return;
        }
        resolve(parsed);
      }
    });

    socket.on("timeout", () => {
      cleanup();
      reject(new Error("ESL command timed out"));
    });

    socket.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function buildCustomerDialString(config: AppConfig, destinationNumber: string): string {
  const digits = normalizeDestinationForDialString(destinationNumber);
  if (config.SIP_TRUNK_MODE === "ip_auth") {
    if (!config.SIP_TRUNK_PROXY) {
      throw new Error("SIP_TRUNK_PROXY is required for ip_auth originate");
    }
    return `sofia/external/${digits}@${config.SIP_TRUNK_PROXY}`;
  }
  if (!config.SIP_TRUNK_PROXY || !config.SIP_TRUNK_USERNAME) {
    throw new Error("SIP_TRUNK_PROXY and SIP_TRUNK_USERNAME are required for registration originate");
  }
  return `sofia/gateway/sip-trunk/${digits}`;
}

function normalizeDestinationForDialString(value: string): string {
  const trimmed = value.trim();
  // Some SIP trunks reject E.164 user parts with a leading plus.
  return trimmed.replace(/\D/g, "");
}

function buildOriginateVariables(values: Array<string | null>): string {
  return values.filter(Boolean).join(",");
}

function escapeOriginateVariable(value: string): string {
  return value.replace(/[{},]/g, "");
}

function parseJobUuid(response: EslCommandResponse): string {
  const match = response.body.match(/Job-UUID:\s*([^\s]+)/i) ?? response.headers["job-uuid"]?.match(/(.+)/);
  return match?.[1]?.trim() ?? "";
}

function parseEslResponse(raw: string): EslCommandResponse | null {
  const headerEnd = raw.indexOf("\n\n");
  if (headerEnd === -1) {
    return null;
  }
  const headers = parseHeaders(raw.slice(0, headerEnd));
  const contentLength = Number(headers["content-length"] ?? 0);
  const bodyStart = headerEnd + 2;
  const availableBody = raw.slice(bodyStart);
  if (contentLength > 0 && Buffer.byteLength(availableBody, "utf8") < contentLength) {
    return null;
  }
  const body = contentLength > 0 ? availableBody.slice(0, contentLength) : headers["reply-text"] ?? availableBody;
  return { body, headers, raw };
}

function parseHeaders(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator === -1) {
          return null;
        }
        return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
      })
      .filter((entry): entry is [string, string] => Boolean(entry))
  );
}

export const __testing = {
  buildAgentBridgeOriginateCommand,
  buildCustomerDialString,
  buildOriginateVariables,
  escapeOriginateVariable,
  normalizeDestinationForDialString,
  parseEslResponse,
  parseHeaders,
  parseJobUuid
};
