import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { setFreeSwitchEventListenerSubscribed } from "./esl-listener-state.js";
import { registerHealthRoutes } from "./health.js";

describe("health routes", () => {
  it("keeps liveness healthy when dependencies are unavailable", async () => {
    const app = Fastify();
    registerHealthRoutes(app, config(), failingPool());

    const response = await app.inject({ method: "GET", url: "/health/live" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ok");
    await app.close();
  });

  it("returns 503 when readiness is degraded", async () => {
    const app = Fastify();
    registerHealthRoutes(app, config(), failingPool());

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().status, "degraded");
    assert.equal(response.json().checks.postgres.status, "error");
    await app.close();
  });

  it("keeps the compatibility health route ready when PostgreSQL is available", async () => {
    const app = Fastify();
    registerHealthRoutes(app, config(), healthyPool());

    const response = await app.inject({ method: "GET", url: "/health" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ok");
    await app.close();
  });

  it("reports an enabled but unsubscribed event listener as not ready", async () => {
    setFreeSwitchEventListenerSubscribed(false);
    const app = Fastify();
    registerHealthRoutes(
      app,
      {
        ...config(),
        FREESWITCH_ESL_ENABLED: true,
        FREESWITCH_ESL_HOST: "127.0.0.1",
        FREESWITCH_ESL_PORT: 1,
        FREESWITCH_ESL_PASSWORD: "test"
      } as AppConfig,
      healthyPool()
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().checks.freeswitchEventListener.status, "error");
    assert.equal(response.json().checks.freeswitchEventListener.message, "event listener is not subscribed");
    await app.close();
  });
});

function config(): AppConfig {
  return {
    FREESWITCH_ESL_ENABLED: false
  } as AppConfig;
}

function healthyPool(): pg.Pool {
  return {
    query: () => Promise.resolve({ rows: [{ now: new Date("2026-07-13T00:00:00.000Z") }], rowCount: 1 })
  } as unknown as pg.Pool;
}

function failingPool(): pg.Pool {
  return {
    query: () => Promise.reject(new Error("PostgreSQL unavailable"))
  } as unknown as pg.Pool;
}
