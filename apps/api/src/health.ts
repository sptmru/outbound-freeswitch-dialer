import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { HealthResponse } from "@outbound-dialer/shared";
import type { AppConfig } from "./config.js";
import { checkPostgres } from "./db.js";
import { checkFreeSwitchEsl } from "./esl.js";
import { isFreeSwitchEventListenerSubscribed } from "./esl-listener-state.js";

export function registerHealthRoutes(app: FastifyInstance, config: AppConfig, pool: pg.Pool): void {
  app.get("/health/live", async () => ({
    status: "ok",
    service: "api",
    uptimeSeconds: Math.round(process.uptime())
  }));

  const readiness = async (): Promise<HealthResponse> => {
    const postgres = await check(() => checkPostgres(pool));
    const freeswitchEventListener = config.FREESWITCH_ESL_ENABLED
      ? isFreeSwitchEventListenerSubscribed()
        ? { status: "ok" as const, message: "event listener subscribed" }
        : { status: "error" as const, message: "event listener is not subscribed" }
      : { status: "skipped" as const, message: "disabled by configuration" };
    const freeswitchEsl = config.FREESWITCH_ESL_ENABLED
      ? freeswitchEventListener.status === "ok"
        ? await check(() => checkFreeSwitchEsl(config))
        : { status: "skipped" as const, message: "event listener is not subscribed" }
      : { status: "skipped" as const, message: "disabled by configuration" };

    const status =
      postgres.status === "ok" &&
      freeswitchEsl.status !== "error" &&
      freeswitchEventListener.status !== "error"
        ? "ok"
        : "degraded";

    return {
      status,
      service: "api",
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        postgres,
        freeswitchEsl,
        freeswitchEventListener
      }
    };
  };

  for (const path of ["/health", "/health/ready"] as const) {
    app.get(path, async (_request, reply) => {
      const response = await readiness();
      return reply.code(response.status === "ok" ? 200 : 503).send(response);
    });
  }
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
