import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, chown, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { buildPcapDisplayFilter, type PcapFilterSelection } from "./pcap-filter.js";
import { PcapOperationCoordinator } from "./pcap-operation-coordinator.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const socketPath = process.env.PCAP_CAPTURE_SOCKET || "/run/outbound-dialer-pcap/capture.sock";
const storageDir = resolve(process.env.PCAP_STORAGE_DIR || "/var/lib/outbound-dialer/pcaps");
const captureEnabled = true;
const captureInterface = safeInterface(process.env.PCAP_CAPTURE_INTERFACE || "any");
const captureFilter = buildCaptureFilter(process.env);
const captures = new Map<string, { child: ChildProcess; filePath: string; stderr: string }>();
const operations = new PcapOperationCoordinator();

type SupervisorResult = {
  body: Record<string, unknown>;
  status: number;
};

await mkdir(dirname(socketPath), { recursive: true });
await mkdir(storageDir, { recursive: true });
await rm(socketPath, { force: true });

const server = http.createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && request.url === "/health") {
    send(response, 200, { status: "ok", captureEnabled, activeCaptures: captures.size });
    return;
  }

  const match = request.url?.match(/^\/captures\/([^/]+)\/(start|stop)$/);
  const callId = match?.[1] ? decodeURIComponent(match[1]) : "";
  const action = match?.[2];
  if (request.method !== "POST" || !action || !UUID_PATTERN.test(callId)) {
    send(response, 404, { message: "Not found" });
    return;
  }

  try {
    const requestBody = action === "stop" ? await readJsonBody(request) : {};
    const result = await operations.run(callId, action, () =>
      action === "start" ? startCallCapture(callId) : stopCallCapture(callId, requestBody)
    );
    send(response, result.status, result.body);
  } catch (error) {
    send(response, 500, {
      callId,
      running: captures.has(callId),
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

async function startCallCapture(callId: string): Promise<SupervisorResult> {
  const current = captures.get(callId);
  if (current) {
    return { status: 200, body: { callId, running: true } };
  }
  const filePath = rawCapturePath(callId);
  if ((await exists(filePath)) || (await exists(capturePath(callId)))) {
    throw new Error("A PCAP file already exists for this call");
  }
  let capture: Awaited<ReturnType<typeof startCapture>>;
  try {
    capture = await startCapture(filePath);
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  }
  captures.set(callId, capture);
  capture.child.once("exit", () => captures.delete(callId));
  return { status: 201, body: { callId, running: true } };
}

async function stopCallCapture(
  callId: string,
  requestBody: Record<string, unknown>
): Promise<SupervisorResult> {
  const capture = captures.get(callId);
  if (capture) {
    await stopCapture(capture.child);
    captures.delete(callId);
  }
  const selection = parseSelection(requestBody.selection);
  const rawFilePath = rawCapturePath(callId);
  const filePath = capturePath(callId);
  if (!(await exists(rawFilePath)) && (await exists(filePath))) {
    await secureCapture(filePath);
    const file = await stat(filePath);
    return { status: 200, body: { callId, running: false, fileSizeBytes: file.size } };
  }
  try {
    await isolateCapture(rawFilePath, filePath, selection);
    await secureCapture(filePath);
  } finally {
    await rm(rawFilePath, { force: true });
  }
  const file = await stat(filePath);
  return { status: 200, body: { callId, running: false, fileSizeBytes: file.size } };
}

async function secureCapture(filePath: string): Promise<void> {
  await chown(filePath, 0, 0);
  await chmod(filePath, 0o600);
}

server.listen(socketPath, () => {
  void chmod(socketPath, 0o660);
  process.stdout.write(
    `${JSON.stringify({ event: "pcap_supervisor_started", socketPath, storageDir, captureEnabled })}\n`
  );
});

const shutdown = async (): Promise<void> => {
  server.close();
  await Promise.allSettled([...captures.values()].map((capture) => stopCapture(capture.child)));
  await rm(socketPath, { force: true });
};

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

async function startCapture(
  filePath: string
): Promise<{ child: ChildProcess; filePath: string; stderr: string }> {
  const child = spawn(
    "tcpdump",
    ["-i", captureInterface, "-n", "-U", "-s", "0", "-B", "4096", "-w", filePath, captureFilter],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const capture = { child, filePath, stderr: "" };
  child.stderr?.on("data", (chunk: Buffer) => {
    capture.stderr = `${capture.stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  await new Promise<void>((resolveStart, rejectStart) => {
    const timer = setTimeout(resolveStart, 150);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectStart(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectStart(new Error(capture.stderr.trim() || `tcpdump exited during startup with code ${code}`));
    });
  });
  return capture;
}

async function stopCapture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  if (!child.kill("SIGINT")) {
    throw new Error("Could not signal tcpdump to stop");
  }
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000);
  forceKill.unref?.();
  await exited;
  clearTimeout(forceKill);
}

function capturePath(callId: string): string {
  const filePath = resolve(storageDir, `${callId}.pcap`);
  if (!filePath.startsWith(`${storageDir}${sep}`)) {
    throw new Error("PCAP path escaped the configured storage directory");
  }
  return filePath;
}

function rawCapturePath(callId: string): string {
  const filePath = resolve(storageDir, `${callId}.capture.pcap`);
  if (!filePath.startsWith(`${storageDir}${sep}`)) {
    throw new Error("Raw PCAP path escaped the configured storage directory");
  }
  return filePath;
}

async function isolateCapture(
  rawFilePath: string,
  filePath: string,
  selection: PcapFilterSelection
): Promise<void> {
  const displayFilter = buildPcapDisplayFilter(selection);
  const temporaryPath = `${filePath}.tmp`;
  await rm(temporaryPath, { force: true });
  try {
    await runProcess("tshark", [
      "-n",
      "-r",
      rawFilePath,
      "-Y",
      displayFilter,
      "-F",
      "pcap",
      "-w",
      temporaryPath
    ]);
    const file = await stat(temporaryPath);
    if (file.size <= 24) {
      throw new Error("PCAP isolation completed without packets for this call");
    }
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    child.once("error", rejectProcess);
    child.once("exit", (code) => {
      if (code === 0) resolveProcess();
      else rejectProcess(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65_536) throw new Error("PCAP supervisor request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PCAP supervisor request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function parseSelection(value: unknown): PcapFilterSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PCAP isolation selection is required");
  }
  const selection = value as Record<string, unknown>;
  if (!Array.isArray(selection.mediaPorts) || !Array.isArray(selection.sipCallIds)) {
    throw new Error("PCAP isolation selection is invalid");
  }
  return {
    mediaPorts: selection.mediaPorts.map(Number),
    sipCallIds: selection.sipCallIds.filter((item): item is string => typeof item === "string")
  };
}

export function buildCaptureFilter(env: NodeJS.ProcessEnv): string {
  const ports = [
    port(env.FREESWITCH_INTERNAL_SIP_PORT, 5060),
    port(env.FREESWITCH_EXTERNAL_PROFILE_SIP_PORT, 5080),
    port(env.FREESWITCH_EXTERNAL_PROFILE_TLS_PORT, 5081),
    port(env.FREESWITCH_WEBRTC_WSS_PORT, 7443)
  ];
  const rtpStart = port(env.FREESWITCH_RTP_START_PORT, 16384);
  const rtpEnd = port(env.FREESWITCH_RTP_END_PORT, 16484);
  if (rtpStart > rtpEnd) {
    throw new Error("FREESWITCH_RTP_START_PORT must not exceed FREESWITCH_RTP_END_PORT");
  }
  return `(${ports.map((value) => `port ${value}`).join(" or ")} or portrange ${rtpStart}-${rtpEnd})`;
}

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid capture port: ${value}`);
  }
  return parsed;
}

function safeInterface(value: string): string {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) {
    throw new Error("PCAP_CAPTURE_INTERFACE contains unsupported characters");
  }
  return value;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function send(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}
