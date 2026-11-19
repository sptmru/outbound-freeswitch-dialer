import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer, request } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { IngressJournal, captureFromDump, ingressUuid, type IngressRecord } from "./ingress-journal.js";
import { sendFreeSwitchApiCommand } from "./esl.js";
import type { AppConfig } from "./config.js";
export type IngressCommand = (command: string) => Promise<string>;
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
  let running = false,
    failures = 0;
  const http = (control: boolean) =>
    createServer({ connectionsCheckingInterval: 100 }, async (req, res) => {
      const exclusive = !(control && req.method === "GET") && req.url !== "/admission";
      if (running && exclusive) {
        failures++;
        res.writeHead(503).end();
        return;
      }
      if (exclusive) running = true;
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          assert.ok(body.length <= 256);
        }
        if (control && req.method === "GET" && req.url === "/records") {
          res.end(JSON.stringify(journal.records()));
        } else if (control && req.method === "GET" && req.url === "/status") {
          res.end(JSON.stringify({ ...journal.status(), failures }));
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
            journal.capture(captureFromDump(uuid, await command(`uuid_dump ${uuid}`)));
            res.end(`stored:${uuid}`);
          } else if (!control && req.url === "/admission") {
            res.end(journal.admission(uuid));
          } else if (control && req.url === "/admit") {
            journal.admit(uuid, p.get("operationId") ?? "");
            res.end("admitted");
          } else if (req.url === "/terminal") {
            assert.equal((await command(`uuid_exists ${uuid}`)).trim(), "false", "Absence not confirmed");
            const row = journal.terminal(uuid);
            res.end(control ? JSON.stringify(row) : `stored:${uuid}`);
          } else if (control && req.url === "/ack") {
            journal.acknowledge(uuid, Number(p.get("sequence")));
            res.end("acknowledged");
          } else if (control && req.url === "/discover") {
            // Discovery cannot create an unjournalled receipt after its 750ms window.
            journal.capture(captureFromDump(uuid, await command(`uuid_dump ${uuid}`)));
            res.end("discovered");
          } else {
            res.writeHead(404).end();
          }
        }
      } catch {
        failures++;
        // Fixed diagnostics exclude secrets, caller data, SQL errors and curl bodies.
        console.error("D03 journal request failed; evidence retained");
        res.writeHead(503).end("unavailable");
      } finally {
        if (exclusive) running = false;
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
  data?: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: data ? "POST" : "GET", timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1048576) req.destroy(new Error("Journal response exceeded bound"));
      });
      res.on("end", () =>
        res.statusCode === 200 ? resolve(body) : reject(new Error("Ingress journal unavailable"))
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Journal request timeout")));
    req.end(data ? new URLSearchParams(data).toString() : undefined);
  });
}
export const readIngressRecords = async (path: string): Promise<IngressRecord[]> =>
  JSON.parse(await ingressRequest(path, "/records"));

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
