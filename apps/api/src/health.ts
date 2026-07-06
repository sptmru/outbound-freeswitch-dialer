import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { HealthResponse } from "@outbound-dialer/shared";
import type { AppConfig } from "./config.js";
import { checkPostgres } from "./db.js";
import { checkFreeSwitchEsl } from "./esl.js";

export function registerHealthRoutes(app: FastifyInstance, config: AppConfig, pool: pg.Pool): void {
  app.get("/health", async (): Promise<HealthResponse> => {
    const postgres = await check(() => checkPostgres(pool));
    const freeswitchEsl = config.FREESWITCH_ESL_ENABLED
      ? await check(() => checkFreeSwitchEsl(config))
      : { status: "skipped" as const, message: "disabled by configuration" };

    const status = postgres.status === "ok" && freeswitchEsl.status !== "error" ? "ok" : "degraded";

    return {
      status,
      service: "api",
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        postgres,
        freeswitchEsl
      }
    };
  });
}

async function check(fn: () => Promise<string>) {
  try {
    return {
      status: "ok" as const,
      message: await fn()
    };
  } catch (error) {
    return {
      status: "error" as const,
      message: error instanceof Error ? error.message : "unknown error"
    };
  }
}
