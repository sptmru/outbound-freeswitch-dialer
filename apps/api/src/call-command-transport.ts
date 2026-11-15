import net from "node:net";
import type { CommandDriver, CommandResolution, DurableCommand } from "./call-executor.js";

export interface BackgroundJobEvidence {
  jobUuid: string;
  body: string;
  headers: Record<string, string>;
}
/** One authenticated socket and one physical send. No retry, activity-based timer,
 * or random Job-UUID. The executor's total deadline/abort destroys the transport.
 * Job completion still needs the action-specific verifier; ACK never resolves work.
 */
export function createCommandDriver(config: {
  host: string;
  port: number;
  password: string;
  buildCommand: (operation: DurableCommand) => string;
  verify: (
    operation: DurableCommand,
    job: BackgroundJobEvidence,
    signal: AbortSignal
  ) => Promise<CommandResolution | null>;
  reconcile: CommandDriver["reconcile"];
  validate?: CommandDriver["validate"];
}): CommandDriver {
  if (/[\r\n]/.test(config.password)) throw new Error("Invalid ESL password framing");
  return {
    validate: config.validate,
    reconcile: config.reconcile,
    async send(operation, signal) {
      const command = config.buildCommand(operation);
      if (!command || /[\r\n]/.test(command)) throw new Error("Invalid ESL command framing");
      const job = await new Promise<BackgroundJobEvidence>((resolve, reject) => {
        const socket = net.createConnection({ host: config.host, port: config.port });
        let buffer = Buffer.alloc(0);
        let stage = "greeting";
        let settled = false;
        const finish = (error?: Error, evidence?: BackgroundJobEvidence) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          socket.destroy();
          if (error) reject(error);
          else resolve(evidence!);
        };
        const abort = () => finish(new Error("ESL command aborted; outcome uncertain"));
        signal.addEventListener("abort", abort, { once: true });
        socket.on("error", (e) => finish(e));
        socket.on("end", () => finish(new Error("ESL peer ended before job evidence")));
        socket.on("close", () => finish(new Error("ESL peer closed before job evidence")));
        socket.on("data", (data) => {
          buffer = Buffer.concat([buffer, data]);
          if (buffer.length > 1024 * 1024) {
            finish(new Error("ESL frame limit"));
            return;
          }
          while (!settled) {
            const end = buffer.indexOf("\n\n");
            if (end < 0) return;
            const headers = parseHeaders(buffer.subarray(0, end).toString());
            const length = Number(headers["content-length"] ?? 0);
            if (!Number.isSafeInteger(length) || length < 0 || length > 1024 * 1024) {
              finish(new Error("Invalid ESL length"));
              return;
            }
            if (buffer.length < end + 2 + length) return;
            const body = buffer.subarray(end + 2, end + 2 + length).toString();
            buffer = buffer.subarray(end + 2 + length);
            if (stage === "greeting") {
              if (headers["content-type"] !== "auth/request") {
                finish(new Error("Invalid ESL greeting"));
                return;
              }
              socket.write(`auth ${config.password}\n\n`);
              stage = "auth";
            } else if (stage === "auth" || stage === "subscribe") {
              if (!headers["reply-text"]?.startsWith("+OK")) {
                finish(new Error("ESL setup refused"));
                return;
              }
              if (stage === "auth") {
                socket.write("event plain BACKGROUND_JOB\n\n");
                stage = "subscribe";
              } else {
                socket.write(`bgapi ${command}\nJob-UUID: ${operation.command_uuid}\n\n`);
                stage = "job";
              }
            } else if (headers["content-type"] === "command/reply") {
              if (
                !headers["reply-text"]?.startsWith("+OK") ||
                headers["job-uuid"] !== operation.command_uuid
              ) {
                finish(new Error("ESL ACK missing fixed Job-UUID"));
                return;
              }
              // ACK deliberately does not finish the operation.
            } else if (headers["content-type"] === "text/event-plain") {
              const split = body.indexOf("\n\n");
              const event = parseHeaders(split < 0 ? body : body.slice(0, split));
              if (event["event-name"] === "BACKGROUND_JOB" && event["job-uuid"] === operation.command_uuid)
                finish(undefined, {
                  jobUuid: operation.command_uuid,
                  body: split < 0 ? "" : body.slice(split + 2),
                  headers: event
                });
            }
          }
        });
        if (signal.aborted) abort();
      });
      if (signal.aborted) return null;
      return config.verify(operation, job, signal);
    }
  };
}
function parseHeaders(value: string) {
  const headers: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}
