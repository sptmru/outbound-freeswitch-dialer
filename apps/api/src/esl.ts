import net from "node:net";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { DurableCommand } from "./call-executor.js";
import { serviceInviteCommand } from "./service-invite-command.js";
import type { SupervisorMode } from "@outbound-dialer/shared";
import type { AppConfig } from "./config.js";

const TRUNK_ABSOLUTE_CODEC_STRING = "^^:PCMU:PCMA:G729";

export interface EslCommandResponse {
  body: string;
  headers: Record<string, string>;
  raw: string;
}

export interface OriginateCustomerLegInput {
  callerId?: string | null;
  callId: string;
  destinationNumber: string;
  legUuid: string;
}

export interface OriginateAgentBridgeCallInput {
  agentLegUuid: string;
  callerId?: string | null;
  callId: string;
  customerLegUuid: string;
  destinationNumber: string;
  sipUsername: string;
  /** Native C04/C05 operation; its verified endpoint replaces legacy AOR lookup. */
  serviceOperation?: DurableCommand;
}

export interface OriginateSupervisorEavesdropInput {
  callId: string;
  mode: SupervisorMode;
  sessionId: string;
  sipUsername: string;
  supervisorLegUuid: string;
  targetAgentLegUuid: string;
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
  const callerId = input.callerId === undefined ? config.SIP_TRUNK_CALLER_ID : input.callerId;
  const variables = [
    `origination_uuid=${input.legUuid}`,
    `outbound_dialer_call_id=${input.callId}`,
    "ignore_early_media=true",
    "originate_timeout=45",
    callerId ? `origination_caller_id_number=${escapeOriginateVariable(callerId)}` : null
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

export async function originateSupervisorEavesdrop(
  config: AppConfig,
  input: OriginateSupervisorEavesdropInput
): Promise<{ command: string; jobUuid: string; supervisorLegUuid: string }> {
  const command = buildSupervisorEavesdropOriginateCommand(config, input);
  const response = await sendFreeSwitchBgapiCommand(config, command);
  return {
    command,
    jobUuid: parseJobUuid(response),
    supervisorLegUuid: input.supervisorLegUuid
  };
}

export function buildAgentBridgeOriginateCommand(
  config: AppConfig,
  input: OriginateAgentBridgeCallInput
): string {
  const customerDialString = buildCustomerDialString(config, input.destinationNumber);
  const callerId = input.callerId === undefined ? config.SIP_TRUNK_CALLER_ID : input.callerId;
  const agentVariables = buildOriginateVariables([
    `origination_uuid=${input.agentLegUuid}`,
    `outbound_dialer_call_id=${input.callId}`,
    "outbound_dialer_leg_type=agent",
    `sip_h_X-Outbound-Dialer-Call-ID=${input.callId}`,
    "originate_timeout=30",
    "bridge_early_media=true",
    "hangup_after_bridge=true",
    "continue_on_fail=false",
    ...(config.FREESWITCH_WEBRTC_REWRITE_TIMESTAMPS
      ? ["rtp_rewrite_timestamps=true", "rtp_autoflush_during_bridge=true", "rtp_notimer_during_bridge=false"]
      : [])
  ]);
  const customerVariables = buildOriginateVariables([
    `origination_uuid=${input.customerLegUuid}`,
    `outbound_dialer_call_id=${input.callId}`,
    "outbound_dialer_leg_type=customer",
    `absolute_codec_string=${TRUNK_ABSOLUTE_CODEC_STRING}`,
    "ignore_early_media=false",
    "media_bug_answer_req=false",
    "originate_timeout=45",
    ...(config.FREESWITCH_TRUNK_JITTER_BUFFER_MSEC === "off"
      ? []
      : [
          `jitterbuffer_msec=${config.FREESWITCH_TRUNK_JITTER_BUFFER_MSEC}`,
          "rtp_jitter_buffer_during_bridge=true",
          "rtp_jitter_buffer_plc=true",
          "rtp_media_autofix_timing=true",
          "rtp_autoflush_during_bridge=false"
        ]),
    callerId ? `origination_caller_id_number=${escapeOriginateVariable(callerId)}` : null
  ]);
  if (input.serviceOperation) {
    const op = input.serviceOperation;
    assert.equal(op.command_kind, "originate");
    assert.equal(op.call_id, input.callId);
    assert.equal(op.target_uuid, input.agentLegUuid);
    assert.equal(op.request.customerUuid, input.customerLegUuid);
    assert.equal(op.request.destinationNumber, input.destinationNumber);
    // Preserve the established customer/trunk policy, but use exactly the same
    // D01-pinned browser destination and service headers as inbound/transfer.
    const prefix = serviceInviteCommand(op, [
      "outbound_dialer_leg_type=agent",
      "bridge_early_media=true",
      "continue_on_fail=false",
      ...(config.FREESWITCH_WEBRTC_REWRITE_TIMESTAMPS
        ? [
            "rtp_rewrite_timestamps=true",
            "rtp_autoflush_during_bridge=true",
            "rtp_notimer_during_bridge=false"
          ]
        : [])
    ]);
    return `${prefix.slice(0, -"&park()".length)}&bridge({${customerVariables}}${customerDialString})`;
  }
  return `originate {${agentVariables}}user/${input.sipUsername}@${config.FREESWITCH_DOMAIN} &bridge({${customerVariables}}${customerDialString})`;
}

export function buildSupervisorEavesdropOriginateCommand(
  config: AppConfig,
  input: OriginateSupervisorEavesdropInput
): string {
  const variables = buildOriginateVariables([
    `origination_uuid=${input.supervisorLegUuid}`,
    `outbound_dialer_supervisor_session_id=${input.sessionId}`,
    `outbound_dialer_supervisor_call_id=${input.callId}`,
    `outbound_dialer_supervisor_mode=${input.mode}`,
    `sip_h_X-Outbound-Dialer-Supervisor-Session-ID=${input.sessionId}`,
    `sip_h_X-Outbound-Dialer-Supervisor-Mode=${input.mode}`,
    "outbound_dialer_leg_type=supervisor",
    "originate_timeout=15",
    "hangup_after_bridge=true",
    "eavesdrop_enable_dtmf=false",
    "eavesdrop_bridge_aleg=true",
    "eavesdrop_bridge_bleg=true",
    // The eavesdrop target is the agent leg: WRITE feeds the agent speaker, READ feeds the customer.
    input.mode === "join" ? "eavesdrop_whisper_aleg=true" : null,
    input.mode === "whisper" || input.mode === "join" ? "eavesdrop_whisper_bleg=true" : null
  ]);
  return `originate {${variables}}user/${input.sipUsername}@${config.FREESWITCH_DOMAIN} &eavesdrop(${input.targetAgentLegUuid})`;
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

export async function sendFreeSwitchApiCommand(
  config: AppConfig,
  command: string,
  timeoutMilliseconds = 5_000
): Promise<EslCommandResponse> {
  return sendFreeSwitchCommand(config, `api ${command}`, timeoutMilliseconds);
}

export async function sendFreeSwitchBgapiCommand(
  config: AppConfig,
  command: string
): Promise<EslCommandResponse> {
  return sendFreeSwitchCommand(config, `api bgapi ${command}`);
}

async function sendFreeSwitchCommand(
  config: AppConfig,
  command: string,
  timeoutMilliseconds = 5_000
): Promise<EslCommandResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: config.FREESWITCH_ESL_HOST,
      port: config.FREESWITCH_ESL_PORT,
      timeout: timeoutMilliseconds
    });
    let stage: "auth" | "connect" | "command" = "auth";
    let buffer = "";
    let authSent = false;
    let settled = false;

    const finish = (result: { error: Error } | { response: EslCommandResponse }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.removeAllListeners();
      socket.destroy();
      if ("error" in result) reject(result.error);
      else resolve(result.response);
    };
    // A socket inactivity timeout disappears after a clean close and can be
    // postponed by partial data. Bound the entire command, including auth.
    const deadline = setTimeout(
      () => finish({ error: new Error("ESL command timed out") }),
      timeoutMilliseconds
    );

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
        if (parsed.body.startsWith("-ERR") || parsed.headers["reply-text"]?.startsWith("-ERR")) {
          finish({
            error: new Error(parsed.body || parsed.headers["reply-text"] || "FreeSWITCH command failed")
          });
          return;
        }
        finish({ response: parsed });
      }
    });

    socket.on("timeout", () => {
      finish({ error: new Error("ESL command timed out") });
    });

    socket.on("error", (error) => {
      finish({ error });
    });
    const onClosed = () => finish({ error: new Error("ESL connection closed before command response") });
    socket.on("end", onClosed);
    socket.on("close", onClosed);
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
  const body =
    contentLength > 0 ? availableBody.slice(0, contentLength) : (headers["reply-text"] ?? availableBody);
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
  sendFreeSwitchCommand,
  buildAgentBridgeOriginateCommand,
  buildSupervisorEavesdropOriginateCommand,
  buildCustomerDialString,
  buildOriginateVariables,
  escapeOriginateVariable,
  normalizeDestinationForDialString,
  parseEslResponse,
  parseHeaders,
  parseJobUuid
};
