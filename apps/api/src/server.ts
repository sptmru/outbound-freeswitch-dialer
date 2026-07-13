import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerAdminAudit } from "./admin-audit.js";
import { startAgentRegistrationReconciler } from "./agent-registrations.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { startCallRecordingFinalizer } from "./call-recording-finalizer.js";
import { loadConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { startRetentionScheduler } from "./dashboard/retention-scheduler.js";
import { createPool, runMigrations } from "./db.js";
import { startFreeSwitchEventListener } from "./esl-events.js";
import { provisionAllAgentDirectories, startAgentDirectoryReconciler } from "./freeswitch/provisioning.js";
import { registerHealthRoutes } from "./health.js";
import { registerMetrics } from "./metrics.js";
import { startPcapCaptureFinalizer } from "./pcap-capture.js";
import {
  createLiveEventHub,
  registerLiveEventRoutes,
  startDatabaseLiveEventListener
} from "./live-events.js";
import {
  isTrustedProxyAddress,
  registerCookieCsrfProtection,
  registerLoginRateLimit,
  sanitizeRequestUrl
} from "./security.js";
import { bootstrapAdmin, migrateAgentSipSecretEncryption } from "./users.js";

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    serializers: {
      req(request) {
        return {
          host: request.headers.host,
          method: request.method,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
          url: sanitizeRequestUrl(request.url)
        };
      }
    }
  },
  trustProxy: isTrustedProxyAddress
});
const pool = createPool(config);
const liveEventHub = createLiveEventHub();
let stopFreeSwitchEventListener: (() => void) | null = null;
let stopAgentRegistrationReconciler: (() => void) | null = null;
let stopDatabaseLiveEventListener: (() => void) | null = null;
let stopRetentionScheduler: (() => void) | null = null;
let stopAgentDirectoryReconciler: (() => void) | null = null;
let stopCallRecordingFinalizer: (() => void) | null = null;
let stopPcapCaptureFinalizer: (() => void) | null = null;

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      message: "Validation failed",
      issues: error.issues
    });
  }

  if (isPostgresError(error, "23505")) {
    return reply.code(409).send({
      message: "Record already exists"
    });
  }

  if (isHttpError(error)) {
    return reply.code(error.statusCode).send({
      message: error.message
    });
  }

  app.log.error(error);
  return reply.code(500).send({
    message: "Internal server error"
  });
});

function isPostgresError(error: unknown, code: string): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isHttpError(error: unknown): error is { message: string; statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    "message" in error &&
    typeof error.message === "string"
  );
}

await app.register(cookie);
await app.register(cors, {
  credentials: true,
  origin: config.corsOrigins
});
await app.register(multipart, {
  limits: {
    fileSize: config.VOICEMAIL_UPLOAD_MAX_BYTES,
    files: 1
  }
});
registerLoginRateLimit(app, config);
registerCookieCsrfProtection(app, config);
registerAdminAudit(app, config, pool);

registerHealthRoutes(app, config, pool);
registerMetrics(app, config, pool);
registerAuthRoutes(app, config, pool);
registerDashboardRoutes(app, config, pool);
registerLiveEventRoutes(app, config, pool, liveEventHub);

app.get("/", async () => ({
  service: "outbound-dialer-api",
  status: "ok"
}));

async function start() {
  await runMigrations(pool);
  const migratedSipSecrets = await migrateAgentSipSecretEncryption(pool, config);
  if (migratedSipSecrets) {
    app.log.info({ migratedSipSecrets }, "SIP credentials migrated to the dedicated encryption key");
  }
  const provisionedAgents = await provisionAllAgentDirectories(pool, config);
  app.log.info({ provisionedAgents }, "FreeSWITCH agent directory synchronized");
  const admin = await bootstrapAdmin(pool, config);
  if (admin) {
    app.log.info({ email: admin.email }, "bootstrap admin is available");
  }
  await app.listen({
    host: config.API_HOST,
    port: config.API_PORT
  });
  stopDatabaseLiveEventListener = startDatabaseLiveEventListener(pool, liveEventHub, app.log);
  stopRetentionScheduler = startRetentionScheduler(pool, config, app.log).stop;
  stopCallRecordingFinalizer = startCallRecordingFinalizer(pool, config.FFPROBE_PATH, app.log).stop;
  stopPcapCaptureFinalizer = startPcapCaptureFinalizer(pool, config, app.log).stop;
  stopFreeSwitchEventListener = startFreeSwitchEventListener(config, pool, app.log);
  stopAgentRegistrationReconciler = startAgentRegistrationReconciler(config, pool, app.log);
  stopAgentDirectoryReconciler = startAgentDirectoryReconciler(pool, config, app.log);
}

const shutdown = async () => {
  app.log.info("shutting down");
  stopAgentRegistrationReconciler?.();
  stopAgentDirectoryReconciler?.();
  stopFreeSwitchEventListener?.();
  stopCallRecordingFinalizer?.();
  stopPcapCaptureFinalizer?.();
  stopRetentionScheduler?.();
  stopDatabaseLiveEventListener?.();
  await app.close();
  await pool.end();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
