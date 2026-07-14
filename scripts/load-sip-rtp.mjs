#!/usr/bin/env node

import net from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const config = loadConfig(process.env);
const tokens = await loadTokens(config.tokensFile);
if (tokens.length < config.concurrency) {
  throw new Error(`SIP_RTP_CONCURRENCY=${config.concurrency} requires at least that many unique tokens`);
}

const agents = await Promise.all(
  tokens.slice(0, config.concurrency).map((token, index) => preflightAgent(token, index, config))
);
await sendEslCommand(config, "api status");

const { chromium } = await import("@playwright/test");
const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
});
const activeUuids = new Set();
const startedAt = new Date();

try {
  await Promise.all(agents.map((agent) => registerBrowserAgent(browser, agent, config)));
  const registrations = await sendEslCommand(config, "api sofia status profile internal-webrtc reg").catch(
    () => null
  );
  for (const agent of agents) {
    agent.freeswitchRegistrationSeen = Boolean(registrations?.body.includes(agent.sipUsername));
  }

  for (const agent of agents) {
    if (!agent.registered) continue;
    agent.callUuid = randomUUID();
    activeUuids.add(agent.callUuid);
    const variables = [
      `origination_uuid=${agent.callUuid}`,
      "originate_timeout=20",
      "ignore_early_media=true",
      "origination_caller_id_name=Local RTP Load Test",
      "origination_caller_id_number=0000"
    ].join(",");
    const command = `api bgapi originate {${variables}}user/${agent.sipUsername}@${agent.domain} &echo()`;
    try {
      const response = await sendEslCommand(config, command);
      agent.originateQueued = /\+OK|Job-UUID/i.test(response.body || response.raw);
    } catch (error) {
      agent.error = messageOf(error);
    }
    await sleep(Math.ceil(1000 / config.callsPerSecond));
  }

  await Promise.all(
    agents.map(async (agent) => {
      if (!agent.page || !agent.originateQueued) return;
      try {
        await agent.page.waitForFunction(
          () =>
            (globalThis.__outboundDialerLoadPeerConnections ?? []).some(
              (connection) => connection.connectionState === "connected"
            ),
          undefined,
          { timeout: config.callSetupTimeoutMilliseconds }
        );
        agent.callEstablished = true;
      } catch (error) {
        agent.error = agent.error ?? `Call did not establish: ${messageOf(error)}`;
      }
    })
  );

  if (agents.some((agent) => agent.callEstablished)) {
    await sleep(config.mediaDurationSeconds * 1000);
  }
  await Promise.all(
    agents.map(async (agent) => {
      if (!agent.page || !agent.callEstablished) return;
      try {
        agent.rtp = await collectWebRtcStats(agent.page);
      } catch (error) {
        agent.error = agent.error ?? `Could not collect WebRTC stats: ${messageOf(error)}`;
      }
    })
  );
} finally {
  await Promise.allSettled(
    [...activeUuids].map((uuid) => sendEslCommand(config, `api uuid_kill ${uuid} NORMAL_CLEARING`))
  );
  await browser.close().catch(() => undefined);
}

const endedAt = new Date();
const results = agents.map((agent) => ({
  index: agent.index + 1,
  sipUsername: agent.sipUsername,
  registered: agent.registered,
  freeswitchRegistrationSeen: agent.freeswitchRegistrationSeen,
  originateQueued: agent.originateQueued,
  callEstablished: agent.callEstablished,
  rtp: agent.rtp,
  browserDiagnostics: agent.browserDiagnostics,
  error: agent.error
}));
const totals = results.reduce(
  (current, result) => ({
    inboundBytes: current.inboundBytes + (result.rtp?.inboundBytes ?? 0),
    inboundPackets: current.inboundPackets + (result.rtp?.inboundPackets ?? 0),
    outboundBytes: current.outboundBytes + (result.rtp?.outboundBytes ?? 0),
    outboundPackets: current.outboundPackets + (result.rtp?.outboundPackets ?? 0),
    packetsLost: current.packetsLost + (result.rtp?.packetsLost ?? 0)
  }),
  { inboundBytes: 0, inboundPackets: 0, outboundBytes: 0, outboundPackets: 0, packetsLost: 0 }
);
const packetLossRate =
  totals.inboundPackets + totals.packetsLost > 0
    ? totals.packetsLost / (totals.inboundPackets + totals.packetsLost)
    : 1;
const registered = results.filter((result) => result.registered).length;
const established = results.filter((result) => result.callEstablished).length;
const mediaFlowing = results.filter(
  (result) => (result.rtp?.inboundPackets ?? 0) > 0 && (result.rtp?.outboundPackets ?? 0) > 0
).length;
const maximumJitterSeconds = Math.max(0, ...results.map((result) => result.rtp?.maximumJitterSeconds ?? 0));
const violations = [];
if (registered !== config.concurrency)
  violations.push(`${registered}/${config.concurrency} agents registered`);
if (established !== config.concurrency)
  violations.push(`${established}/${config.concurrency} calls established`);
if (mediaFlowing !== config.concurrency)
  violations.push(`${mediaFlowing}/${config.concurrency} calls had two-way RTP`);
if (packetLossRate > config.maximumPacketLossRate) {
  violations.push(`RTP packet loss rate ${round(packetLossRate, 6)} exceeds ${config.maximumPacketLossRate}`);
}
if (maximumJitterSeconds > config.maximumJitterSeconds) {
  violations.push(`RTP jitter ${round(maximumJitterSeconds, 6)}s exceeds ${config.maximumJitterSeconds}s`);
}

const report = {
  schemaVersion: 1,
  mode: "local-freeswitch-echo",
  target: config.baseUrl,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  concurrency: config.concurrency,
  callsPerSecond: config.callsPerSecond,
  mediaDurationSeconds: config.mediaDurationSeconds,
  registered,
  established,
  mediaFlowing,
  totals: {
    ...totals,
    packetLossRate: round(packetLossRate, 6),
    maximumJitterSeconds: round(maximumJitterSeconds, 6)
  },
  thresholds: {
    maximumPacketLossRate: config.maximumPacketLossRate,
    maximumJitterSeconds: config.maximumJitterSeconds
  },
  agents: results,
  passed: violations.length === 0,
  violations
};
const output = `${JSON.stringify(report, null, 2)}\n`;
process.stdout.write(output);
if (config.reportPath) {
  const reportPath = resolve(config.reportPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, output, { mode: 0o600 });
  await chmod(reportPath, 0o600);
}
if (!report.passed) process.exitCode = 1;

async function preflightAgent(token, index, currentConfig) {
  const [me, provisioning, desk] = await Promise.all([
    apiJson(currentConfig, token, "/auth/me"),
    apiJson(currentConfig, token, "/agent/softphone/provisioning"),
    apiJson(currentConfig, token, "/agent/desk")
  ]);
  if (me.user?.role !== "agent") throw new Error(`Token ${index + 1} does not belong to an agent`);
  if (desk.activeCall) throw new Error(`Test agent ${index + 1} already has an active product call`);
  const sipUsername = String(provisioning.sipUsername ?? "");
  const domain = String(provisioning.domain ?? "");
  if (!/^[A-Za-z0-9_.-]+$/.test(sipUsername)) throw new Error(`Unsafe SIP username for token ${index + 1}`);
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) throw new Error(`Unsafe SIP domain for token ${index + 1}`);
  return {
    index,
    token,
    sipUsername,
    domain,
    context: null,
    page: null,
    registered: false,
    originateQueued: false,
    callEstablished: false,
    callUuid: null,
    rtp: null,
    freeswitchRegistrationSeen: false,
    browserDiagnostics: null,
    error: null
  };
}

async function registerBrowserAgent(browserInstance, agent, currentConfig) {
  const events = { console: [], pageErrors: [], requestFailures: [], webSockets: [] };
  try {
    const context = await browserInstance.newContext({ permissions: ["microphone"] });
    agent.context = context;
    await context.addInitScript(() => {
      const connections = [];
      Object.defineProperty(globalThis, "__outboundDialerLoadPeerConnections", {
        configurable: false,
        value: connections
      });
      const NativePeerConnection = globalThis.RTCPeerConnection;
      function InstrumentedPeerConnection(...argumentsList) {
        const connection = new NativePeerConnection(...argumentsList);
        connections.push(connection);
        return connection;
      }
      InstrumentedPeerConnection.prototype = NativePeerConnection.prototype;
      Object.setPrototypeOf(InstrumentedPeerConnection, NativePeerConnection);
      globalThis.RTCPeerConnection = InstrumentedPeerConnection;
    });
    await context.addCookies([
      {
        name: "outbound_dialer_session",
        value: agent.token,
        url: currentConfig.appUrl,
        httpOnly: true,
        secure: new URL(currentConfig.appUrl).protocol === "https:",
        sameSite: "Strict"
      }
    ]);
    const page = await context.newPage();
    agent.page = page;
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        pushDiagnostic(events.console, `${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => pushDiagnostic(events.pageErrors, messageOf(error)));
    page.on("requestfailed", (request) =>
      pushDiagnostic(
        events.requestFailures,
        `${request.method()} ${diagnosticUrl(request.url())}: ${request.failure()?.errorText ?? "failed"}`
      )
    );
    page.on("websocket", (webSocket) => {
      const record = {
        url: diagnosticUrl(webSocket.url()),
        closed: false,
        error: null,
        sentSip: [],
        receivedSip: []
      };
      events.webSockets.push(record);
      webSocket.on("close", () => {
        record.closed = true;
      });
      webSocket.on("socketerror", (error) => {
        record.error = sanitizeDiagnostic(error);
      });
      webSocket.on("framesent", ({ payload }) => pushSipSummary(record.sentSip, payload));
      webSocket.on("framereceived", ({ payload }) => pushSipSummary(record.receivedSip, payload));
    });
    await page.goto(currentConfig.appUrl, { waitUntil: "domcontentloaded" });
    await page.getByText("Phone ready", { exact: true }).waitFor({
      state: "visible",
      timeout: currentConfig.registrationTimeoutMilliseconds
    });
    agent.registered = true;
  } catch (error) {
    agent.browserDiagnostics = await collectBrowserDiagnostics(agent.page, events);
    const state = agent.browserDiagnostics?.visiblePhoneState ?? "unknown phone state";
    const webSocketError = agent.browserDiagnostics?.webSockets?.find((webSocket) => webSocket.error)?.error;
    agent.error = webSocketError
      ? `Registration failed (${state}): WSS ${webSocketError}`
      : `Registration failed (${state}): ${messageOf(error)}`;
  }
}

async function collectBrowserDiagnostics(page, events) {
  if (!page) return { ...events, visiblePhoneState: "page was not created" };
  let runtime = null;
  try {
    runtime = await page.evaluate(async () => {
      const requestStatus = async (path) => {
        try {
          return (await globalThis.fetch(path, { credentials: "include" })).status;
        } catch {
          return 0;
        }
      };
      let microphonePermission = "unavailable";
      try {
        microphonePermission = (await globalThis.navigator.permissions.query({ name: "microphone" })).state;
      } catch {
        // Some Chromium builds do not expose microphone through Permissions API.
      }
      const bodyText = globalThis.document.body?.innerText ?? "";
      const phoneStates = [
        "Phone ready",
        "Connecting phone",
        "Phone unavailable",
        "Microphone access needed",
        "● Phone connected",
        "● Phone offline",
        "● Mic allowed",
        "● Mic blocked"
      ].filter((label) => bodyText.includes(label));
      return {
        url: globalThis.location?.href,
        title: globalThis.document.title,
        secureContext: globalThis.isSecureContext,
        mediaDevicesAvailable: Boolean(globalThis.navigator.mediaDevices?.getUserMedia),
        microphonePermission,
        authStatus: await requestStatus("/api/auth/me"),
        provisioningStatus: await requestStatus("/api/agent/softphone/provisioning"),
        loginScreenVisible: bodyText.includes("Outbound calling workspace"),
        phoneStates
      };
    });
  } catch (error) {
    runtime = { evaluationError: sanitizeDiagnostic(messageOf(error)) };
  }
  return {
    ...runtime,
    visiblePhoneState: runtime?.phoneStates?.join(", ") || "no phone status rendered",
    console: [...events.console],
    pageErrors: [...events.pageErrors],
    requestFailures: [...events.requestFailures],
    webSockets: events.webSockets.map((webSocket) => ({ ...webSocket }))
  };
}

async function collectWebRtcStats(page) {
  return page.evaluate(async () => {
    const connections = globalThis.__outboundDialerLoadPeerConnections ?? [];
    const totals = {
      inboundBytes: 0,
      inboundPackets: 0,
      outboundBytes: 0,
      outboundPackets: 0,
      packetsLost: 0,
      maximumJitterSeconds: 0,
      peerConnections: connections.length,
      connectionStates: []
    };
    for (const connection of connections) {
      totals.connectionStates.push(connection.connectionState);
      const stats = await connection.getStats();
      for (const entry of stats.values()) {
        const kind = entry.kind ?? entry.mediaType;
        if (kind !== "audio") continue;
        if (entry.type === "inbound-rtp" && !entry.isRemote) {
          totals.inboundBytes += entry.bytesReceived ?? 0;
          totals.inboundPackets += entry.packetsReceived ?? 0;
          totals.packetsLost += Math.max(0, entry.packetsLost ?? 0);
          totals.maximumJitterSeconds = Math.max(totals.maximumJitterSeconds, entry.jitter ?? 0);
        }
        if (entry.type === "outbound-rtp" && !entry.isRemote) {
          totals.outboundBytes += entry.bytesSent ?? 0;
          totals.outboundPackets += entry.packetsSent ?? 0;
        }
      }
    }
    return totals;
  });
}

async function apiJson(currentConfig, token, path) {
  const response = await fetch(`${currentConfig.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(currentConfig.requestTimeoutMilliseconds)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return body;
}

async function loadTokens(path) {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) throw new Error("LOAD_AUTH_TOKENS_FILE must have mode 600");
  const values = (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(values)];
  if (!unique.length) throw new Error("LOAD_AUTH_TOKENS_FILE is empty");
  return unique;
}

function loadConfig(environment) {
  const baseUrl = environment.LOAD_BASE_URL?.trim().replace(/\/$/, "");
  const tokensFile = environment.LOAD_AUTH_TOKENS_FILE?.trim();
  if (!baseUrl) throw new Error("Set LOAD_BASE_URL; include /api for the public deployment");
  if (!tokensFile) throw new Error("Set LOAD_AUTH_TOKENS_FILE");
  const apiUrl = new URL(baseUrl);
  const appUrl = environment.SIP_RTP_APP_URL?.trim().replace(/\/$/, "") || deriveAppUrl(apiUrl);
  const approvedTarget = environment.LOAD_APPROVED_TARGET?.trim().replace(/\/$/, "");
  if (!isLoopback(apiUrl.hostname) && approvedTarget !== baseUrl) {
    throw new Error(`Set LOAD_APPROVED_TARGET exactly to ${baseUrl}`);
  }
  if (environment.SIP_RTP_RUN_CONFIRM !== "local-freeswitch-echo") {
    throw new Error(
      "Set SIP_RTP_RUN_CONFIRM=local-freeswitch-echo after confirming these are dedicated test agents"
    );
  }
  const eslPassword = environment.SIP_RTP_ESL_PASSWORD || environment.FREESWITCH_ESL_PASSWORD;
  if (!eslPassword) throw new Error("Set SIP_RTP_ESL_PASSWORD or FREESWITCH_ESL_PASSWORD");
  return {
    baseUrl,
    appUrl,
    tokensFile: resolve(tokensFile),
    reportPath: environment.SIP_RTP_REPORT_PATH?.trim(),
    concurrency: boundedInteger(environment.SIP_RTP_CONCURRENCY, 5, 1, 50, "SIP_RTP_CONCURRENCY"),
    callsPerSecond: boundedNumber(
      environment.SIP_RTP_CALLS_PER_SECOND,
      1,
      0.1,
      10,
      "SIP_RTP_CALLS_PER_SECOND"
    ),
    mediaDurationSeconds: boundedInteger(
      environment.SIP_RTP_MEDIA_DURATION_SECONDS,
      20,
      5,
      300,
      "SIP_RTP_MEDIA_DURATION_SECONDS"
    ),
    registrationTimeoutMilliseconds: boundedInteger(
      environment.SIP_RTP_REGISTRATION_TIMEOUT_MS,
      30_000,
      5_000,
      120_000,
      "SIP_RTP_REGISTRATION_TIMEOUT_MS"
    ),
    callSetupTimeoutMilliseconds: boundedInteger(
      environment.SIP_RTP_CALL_SETUP_TIMEOUT_MS,
      30_000,
      5_000,
      120_000,
      "SIP_RTP_CALL_SETUP_TIMEOUT_MS"
    ),
    requestTimeoutMilliseconds: boundedInteger(
      environment.LOAD_REQUEST_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
      "LOAD_REQUEST_TIMEOUT_MS"
    ),
    maximumPacketLossRate: boundedNumber(
      environment.SIP_RTP_MAX_PACKET_LOSS_RATE,
      0.01,
      0,
      1,
      "SIP_RTP_MAX_PACKET_LOSS_RATE"
    ),
    maximumJitterSeconds: boundedNumber(
      environment.SIP_RTP_MAX_JITTER_SECONDS,
      0.05,
      0,
      5,
      "SIP_RTP_MAX_JITTER_SECONDS"
    ),
    eslHost: environment.SIP_RTP_ESL_HOST?.trim() || "127.0.0.1",
    eslPort: boundedInteger(environment.SIP_RTP_ESL_PORT, 8021, 1, 65535, "SIP_RTP_ESL_PORT"),
    eslPassword
  };
}

function deriveAppUrl(apiUrl) {
  const path = apiUrl.pathname.replace(/\/$/, "");
  if (!path.endsWith("/api")) throw new Error("Set SIP_RTP_APP_URL when LOAD_BASE_URL does not end in /api");
  apiUrl.pathname = path.slice(0, -4) || "/";
  apiUrl.search = "";
  apiUrl.hash = "";
  return apiUrl.toString().replace(/\/$/, "");
}

async function sendEslCommand(currentConfig, command) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({
      host: currentConfig.eslHost,
      port: currentConfig.eslPort,
      timeout: 5_000
    });
    let stage = "auth";
    let buffer = "";
    let authSent = false;
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };
    const fail = (error) => {
      cleanup();
      rejectPromise(error);
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (stage === "auth" && !authSent && buffer.includes("Content-Type: auth/request")) {
        authSent = true;
        socket.write(`auth ${currentConfig.eslPassword}\n\n`);
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
        if (!parsed) return;
        cleanup();
        if (parsed.body.startsWith("-ERR") || parsed.headers["reply-text"]?.startsWith("-ERR")) {
          rejectPromise(new Error(parsed.body || parsed.headers["reply-text"]));
          return;
        }
        resolvePromise(parsed);
      }
    });
    socket.on("timeout", () => fail(new Error("ESL command timed out")));
    socket.on("error", fail);
  });
}

function parseEslResponse(value) {
  const separator = value.indexOf("\n\n");
  if (separator < 0) return null;
  const headerBlock = value.slice(0, separator).replace(/\r/g, "");
  const headers = Object.fromEntries(
    headerBlock
      .split("\n")
      .map((line) => line.split(/:\s*/, 2))
      .filter((parts) => parts.length === 2)
      .map(([key, content]) => [key.toLowerCase(), content])
  );
  const contentLength = Number.parseInt(headers["content-length"] ?? "0", 10);
  const bodyStart = separator + 2;
  if (value.length < bodyStart + contentLength) return null;
  return { headers, body: value.slice(bodyStart, bodyStart + contentLength).trim(), raw: value };
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function boundedNumber(value, fallback, minimum, maximum, name) {
  const parsed = Number.parseFloat(value ?? String(fallback));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function round(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return sanitizeDiagnostic(value);
  }
}

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|access_token)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function pushDiagnostic(target, value) {
  if (target.length < 10) target.push(sanitizeDiagnostic(value));
}

function pushSipSummary(target, payload) {
  if (target.length >= 20) return;
  const value = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
  const firstLine = value.replace(/\r/g, "").split("\n", 1)[0]?.trim() ?? "";
  const cseqMethod = value.match(/^CSeq:\s*\d+\s+([A-Z]+)\s*$/im)?.[1];
  const response = firstLine.match(/^SIP\/2\.0\s+(\d{3})\s*(.*)$/i);
  if (response) {
    target.push(
      `SIP ${response[1]}${response[2] ? ` ${sanitizeDiagnostic(response[2])}` : ""}${cseqMethod ? ` (${cseqMethod})` : ""}`
    );
    return;
  }
  const request = firstLine.match(/^([A-Z]+)\s+\S+\s+SIP\/2\.0$/i);
  target.push(request ? request[1].toUpperCase() : "non-SIP frame");
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
