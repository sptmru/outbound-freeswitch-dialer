import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer, request } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  IngressJournal,
  captureFromDump,
  ingressUuid,
  type IngressJournalEntry,
  type IngressRecord
} from "./ingress-journal.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import type { AppConfig } from "./config.js";
export type IngressCommand = (command: string) => Promise<string>;
const reconciliationMediaType = "application/vnd.outbound-dialer.ingress-reconciliation+json";
export async function startIngressAgent(
  socketPath: string,
  command: IngressCommand,
  slots = 128,
  port = 18093
) {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(socketPath), 0o700);
  const journal = new IngressJournal(join(dirname(socketPath), "ingress.sqlite"), slots);
  await chmod(join(dirname(socketPath), "ingress.sqlite"), 0o600);
  let verification: "capture" | "recovery" | undefined;
  let waitingCapture: (() => void) | undefined;
  let failures = 0,
    lastCaptureFailureUs = 0;
  function recordFailure(native: boolean) {
    failures++;
    if (native) lastCaptureFailureUs = Date.now() * 1000;
  }
  async function verify<T>(kind: "capture" | "recovery", work: () => Promise<T>) {
    if (verification) {
      // Reserve one foreground slot during a bounded background ESL read.
      // Concurrent captures still fail fast and there is only one native read at a time.
      assert.ok(
        kind === "capture" && verification === "recovery" && !waitingCapture,
        "Native verification busy"
      );
      await new Promise<void>((resolve) => (waitingCapture = resolve));
    } else verification = kind;
    try {
      return await work();
    } finally {
      if (waitingCapture) {
        const wake = waitingCapture;
        waitingCapture = undefined;
        verification = "capture";
        wake();
      } else verification = undefined;
    }
  }
  const http = (control: boolean) =>
    createServer({ connectionsCheckingInterval: 100 }, async (req, res) => {
      const capture = !control && (req.url === "/capture" || req.url === "/terminal");
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          assert.ok(body.length <= 256);
        }
        if (control && req.method === "GET" && req.url === "/records") {
          if (req.headers.accept === reconciliationMediaType) {
            res.setHeader("content-type", reconciliationMediaType);
            res.end(JSON.stringify(journal.reconciliationEntries()));
          } else res.end(JSON.stringify(journal.records()));
        } else if (control && req.method === "GET" && req.url === "/status") {
          res.end(JSON.stringify({ ...journal.status(), failures, lastCaptureFailureUs }));
        } else if (control && req.method === "GET" && req.url?.startsWith("/terminal-import?")) {
          const query = new URL(req.url, "http://localhost").searchParams;
          const uuid = query.get("uuid") ?? "";
          const sequence = Number(query.get("sequence"));
          assert.match(uuid, ingressUuid);
          assert.ok(Number.isSafeInteger(sequence) && sequence > 0);
          res.end(journal.needsTerminalImport(uuid, sequence) ? "pending" : "settled");
        } else {
          assert.equal(req.method, "POST");
          const p = new URLSearchParams(body),
            uuid = p.get("uuid") ?? "";
          assert.match(uuid, ingressUuid);
          if (!control && req.url === "/capture") {
            await verify("capture", async () =>
              journal.capture(captureFromDump(uuid, await command(`uuid_dump ${uuid}`)))
            );
            res.end(`stored:${uuid}`);
          } else if (!control && req.url === "/admission") {
            res.end(journal.admission(uuid));
          } else if (control && req.url === "/admit") {
            journal.admit(uuid, p.get("operationId") ?? "");
            res.end("admitted");
          } else if (req.url === "/terminal") {
            const row = await verify("recovery", async () => {
              assert.equal((await command(`uuid_exists ${uuid}`)).trim(), "false", "Absence not confirmed");
              return journal.terminal(uuid);
            });
            res.end(control ? JSON.stringify(row) : `stored:${uuid}`);
          } else if (control && req.url === "/ack") {
            journal.acknowledge(uuid, Number(p.get("sequence")));
            res.end("acknowledged");
          } else if (control && req.url === "/discover") {
            // Discovery cannot create an unjournalled receipt after its 750ms window.
            await verify("recovery", async () =>
              journal.capture(captureFromDump(uuid, await command(`uuid_dump ${uuid}`)))
            );
            res.end("discovered");
          } else {
            res.writeHead(404).end();
          }
        }
      } catch (error) {
        recordFailure(capture);
        // Log only allowlisted failure categories and paths, without native payloads.
        const path = ["/capture", "/terminal", "/admit", "/ack", "/admission", "/discover"].find(
          (candidate) => candidate === req.url
        );
        const reason = [
          "Native verification busy",
          "Capture deadline elapsed",
          "Journal exhausted",
          "Absence not confirmed"
        ].find((candidate) => error instanceof Error && candidate === error.message);
        console.error(
          `D03 journal request failed (${path ?? "other"}: ${reason ?? "unavailable"}); evidence retained`
        );
        res.writeHead(503).end("unavailable");
      }
    });
  const capture = http(false),
    control = http(true);
  for (const server of [capture, control]) {
    server.maxConnections = 8;
    server.requestTimeout = 1000;
    server.headersTimeout = 1000;
    server.keepAliveTimeout = 1;
    server.maxRequestsPerSocket = 1;
    server.setTimeout(1000, (socket) => socket.destroy());
  }
  const listen = (server: ReturnType<typeof createServer>, target: string | number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (typeof target === "number") server.listen(target, "127.0.0.1", resolve);
      else server.listen(target, resolve);
    });
  try {
    await listen(control, socketPath);
    await chmod(socketPath, 0o600);
    await listen(capture, port);
  } catch (error) {
    capture.close();
    control.close();
    journal.close();
    throw error;
  }
  return {
    capturePort: (capture.address() as AddressInfo).port,
    journal,
    async close() {
      await Promise.all(
        [capture, control].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      );
      journal.close();
      await rm(socketPath, { force: true });
    }
  };
}
export async function ingressRequest(
  socketPath: string,
  path: string,
  data?: Record<string, string>,
  accept?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: data ? "POST" : "GET",
        timeout: 2000,
        headers: accept ? { accept } : undefined
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1048576) req.destroy(new Error("Journal response exceeded bound"));
        });
        res.on("end", () =>
          res.statusCode === 200 ? resolve(body) : reject(new Error("Ingress journal unavailable"))
        );
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Journal request timeout")));
    req.end(data ? new URLSearchParams(data).toString() : undefined);
  });
}
export const readIngressRecords = async (path: string): Promise<IngressRecord[]> =>
  JSON.parse(await ingressRequest(path, "/records"));

export async function readIngressReconciliationEntries(path: string): Promise<IngressJournalEntry[]> {
  const entries = JSON.parse(await ingressRequest(path, "/records", undefined, reconciliationMediaType));
  assert.ok(Array.isArray(entries) && entries.length <= 128, "Invalid ingress journal batch");
  // An older agent ignores Accept and returns bare records. Replay those with the original checks.
  return entries.map((entry) => {
    assert.ok(entry && typeof entry === "object", "Invalid ingress journal entry");
    if (!("record" in entry)) return { record: entry, acknowledgedSequence: 0, admissionId: null };
    const { record, acknowledgedSequence, admissionId } = entry;
    assert.ok(record && ingressUuid.test(record.uuid) && ingressUuid.test(record.journalId));
    assert.ok(Number.isSafeInteger(record.sequence) && record.sequence > 0);
    assert.ok(
      Number.isSafeInteger(acknowledgedSequence) &&
        acknowledgedSequence >= 0 &&
        acknowledgedSequence <= record.sequence
    );
    assert.ok(admissionId === null || ingressUuid.test(admissionId));
    return entry;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.FREESWITCH_INGRESS_ENABLED !== "true") {
    console.log("D03 journal disabled");
    setInterval(() => {}, 60000);
  } else {
    const socket = process.env.FREESWITCH_INGRESS_SOCKET ?? "/var/lib/outbound-dialer/ingress/agent.sock";
    // Production launcher owns flock across this unlink and the daemon lifetime.
    await rm(socket, { force: true });
    const config = {
      FREESWITCH_ESL_HOST: "127.0.0.1",
      FREESWITCH_ESL_PORT: Number(process.env.FREESWITCH_ESL_PORT ?? 8021),
      FREESWITCH_ESL_PASSWORD: process.env.FREESWITCH_ESL_PASSWORD
    } as AppConfig;
    const agent = await startIngressAgent(
      socket,
      async (cmd) => (await sendFreeSwitchApiCommand(config, cmd, 300)).body.trim(),
      Number(process.env.FREESWITCH_INGRESS_JOURNAL_SLOTS ?? 128)
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => void agent.close().then(() => process.exit(0)));
  }
}
