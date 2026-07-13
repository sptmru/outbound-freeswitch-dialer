import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, chown, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const socketPath = process.env.PCAP_CAPTURE_SOCKET || "/run/outbound-dialer-pcap/capture.sock";
const storageDir = resolve(process.env.PCAP_STORAGE_DIR || "/var/lib/outbound-dialer/pcaps");
const captureEnabled = process.env.PCAP_CAPTURE_ENABLED === "true";
const captureInterface = safeInterface(process.env.PCAP_CAPTURE_INTERFACE || "any");
const captureFilter = buildCaptureFilter(process.env);
const captures = new Map<string, { child: ChildProcess; filePath: string; stderr: string }>();

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
  if (!captureEnabled) {
    send(response, 503, { callId, running: false, message: "PCAP capture is disabled" });
    return;
  }

  try {
    if (action === "start") {
      const current = captures.get(callId);
      if (current) {
        send(response, 200, { callId, running: true });
        return;
      }
      const filePath = capturePath(callId);
      if (await exists(filePath)) {
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
      send(response, 201, { callId, running: true });
      return;
    }

    const capture = captures.get(callId);
    if (capture) {
      await stopCapture(capture.child);
      captures.delete(callId);
    }
    const filePath = capturePath(callId);
    await chown(filePath, 0, 0);
    await chmod(filePath, 0o600);
    const file = await stat(filePath);
    send(response, 200, { callId, running: false, fileSizeBytes: file.size });
  } catch (error) {
    send(response, 500, {
      callId,
      running: captures.has(callId),
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

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
