import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { loadConfig } from "./config.js";
import { createPool, runMigrations } from "./db.js";
import { registerHealthRoutes } from "./health.js";
import { bootstrapAdmin } from "./users.js";

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.LOG_LEVEL
  }
});
const pool = createPool(config);

await app.register(cors, {
  origin: config.corsOrigins
});

registerHealthRoutes(app, config, pool);
registerAuthRoutes(app, config, pool);

app.get("/", async () => ({
  service: "outbound-dialer-api",
  status: "ok"
}));

async function start() {
  await runMigrations(pool);
  const admin = await bootstrapAdmin(pool, config);
  if (admin) {
    app.log.info({ email: admin.email }, "bootstrap admin is available");
  }
  await app.listen({
    host: config.API_HOST,
    port: config.API_PORT
  });
}

const shutdown = async () => {
  app.log.info("shutting down");
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
