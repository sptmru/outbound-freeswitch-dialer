import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerAuthRoutes } from "./auth/routes.js";
import { loadConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { createPool, runMigrations } from "./db.js";
import { startFreeSwitchEventListener } from "./esl-events.js";
import { provisionAllAgentDirectories } from "./freeswitch/provisioning.js";
import { registerHealthRoutes } from "./health.js";
import { bootstrapAdmin } from "./users.js";

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.LOG_LEVEL
  }
});
const pool = createPool(config);
let stopFreeSwitchEventListener: (() => void) | null = null;

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

await app.register(cors, {
  origin: config.corsOrigins
});
await app.register(multipart, {
  limits: {
    fileSize: 2_000_000,
    files: 1
  }
});

registerHealthRoutes(app, config, pool);
registerAuthRoutes(app, config, pool);
registerDashboardRoutes(app, config, pool);

app.get("/", async () => ({
  service: "outbound-dialer-api",
  status: "ok"
}));

async function start() {
  await runMigrations(pool);
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
  stopFreeSwitchEventListener = startFreeSwitchEventListener(config, pool, app.log);
}

const shutdown = async () => {
  app.log.info("shutting down");
  stopFreeSwitchEventListener?.();
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
