import assert from "node:assert/strict";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import Fastify from "fastify";
import type pg from "pg";
import { registerApiDocumentation } from "./api-documentation.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { AppConfig } from "./config.js";
import { registerDashboardRoutes } from "./dashboard/routes.js";
import { registerHealthRoutes } from "./health.js";
import { createLiveEventHub, registerLiveEventRoutes } from "./live-events.js";
import { registerMetrics } from "./metrics.js";
import { documentedRouteKeys } from "./openapi-routes.js";

test("serves an admin-only OpenAPI catalog with route groups and auth schemes", async () => {
  const app = Fastify();
  await registerApiDocumentation(app, async (request) => {
    const role = request.headers["x-test-role"];
    if (!role) return { allowed: false, statusCode: 401, message: "Unauthorized" };
    if (role !== "admin") return { allowed: false, statusCode: 403, message: "Admin role required" };
    return { allowed: true };
  });
  app.post("/auth/login", async () => ({ token: "test" }));
  app.get("/agent/desk", async () => ({ status: "paused" }));
  app.get("/admin/users", async () => ({ users: [] }));
  app.get("/health/live", async () => ({ status: "ok" }));

  await app.ready();

  const unauthorized = await app.inject({ method: "GET", url: "/docs/json" });
  assert.equal(unauthorized.statusCode, 401);

  const forbidden = await app.inject({
    method: "GET",
    url: "/docs/json",
    headers: { "x-test-role": "agent" }
  });
  assert.equal(forbidden.statusCode, 403);

  const response = await app.inject({
    method: "GET",
    url: "/docs/json",
    headers: { "x-test-role": "admin" }
  });
  assert.equal(response.statusCode, 200, response.body);

  const document = response.json();
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(document.paths["/auth/login"].post.tags, ["Auth"]);
  assert.deepEqual(document.paths["/auth/login"].post.security, []);
  assert.deepEqual(document.paths["/agent/desk"].get.tags, ["Agent"]);
  assert.deepEqual(document.paths["/agent/desk"].get.security, [{ bearerAuth: [] }, { sessionCookie: [] }]);
  assert.deepEqual(document.paths["/admin/users"].get.tags, ["Admin"]);
  assert.deepEqual(document.paths["/health/live"].get.tags, ["System"]);
  assert.ok(document.components.securitySchemes.bearerAuth);

  const ui = await app.inject({
    method: "GET",
    url: "/docs/",
    headers: { "x-test-role": "admin" }
  });
  assert.equal(ui.statusCode, 200, ui.body);
  assert.match(ui.body, /\.\/static\/swagger-ui\.css/);

  const initializer = await app.inject({
    method: "GET",
    url: "/docs/static/swagger-initializer.js",
    headers: { "x-test-role": "admin" }
  });
  assert.equal(initializer.statusCode, 200, initializer.body);
  assert.match(initializer.body, /url: resolveUrl\('\.\/json'\)/);

  await app.close();
});

test("documents every registered API route with request and response contracts", async () => {
  const app = Fastify();
  await registerApiDocumentation(app, async () => ({ allowed: true }));

  const config = {
    FREESWITCH_ESL_ENABLED: false,
    RETENTION_ENABLED: true,
    PCAP_CAPTURE_ENABLED: false,
    CONTACT_MAX_ATTEMPTS: 3,
    CONTACT_RETRY_DELAY_SECONDS: 900
  } as AppConfig;
  const pool = {} as pg.Pool;

  registerHealthRoutes(app, config, pool);
  registerMetrics(app, config, pool);
  registerAuthRoutes(app, config, pool);
  registerDashboardRoutes(app, config, pool);
  registerLiveEventRoutes(app, config, pool, createLiveEventHub());
  app.get("/", async () => ({ service: "outbound-dialer-api", status: "ok" }));

  await app.ready();
  const document = app.swagger() as unknown as OpenApiDocument;
  await SwaggerParser.validate(structuredClone(document) as never);
  const operations = Object.values(document.paths).flatMap((path) =>
    Object.entries(path).filter(([method]) => openApiMethods.has(method))
  );

  assert.equal(operations.length, documentedRouteKeys.length);
  for (const [, operation] of operations) {
    assert.ok(operation.summary, "Every operation must have a summary");
    assert.ok(operation.description, "Every operation must have a description");
    assert.ok(Object.keys(operation.responses).length, "Every operation must document responses");
  }

  const login = document.paths["/auth/login"].post;
  assert.equal(login.requestBody.content["application/json"].schema.properties.email.format, "email");
  assert.equal(
    login.responses[200].content["application/json"].schema.$ref,
    "#/components/schemas/LoginResponse"
  );

  const analytics = document.paths["/admin/analytics"].get;
  assert.deepEqual(analytics.parameters.map((parameter) => parameter.name).sort(), [
    "campaignId",
    "from",
    "timeZone",
    "to"
  ]);
  assert.equal(
    analytics.responses[200].content["application/json"].schema.$ref,
    "#/components/schemas/AdminAnalyticsResponse"
  );

  const browserMedia = document.paths["/agent/calls/{callId}/browser-media"].put;
  assert.equal(
    browserMedia.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/BrowserMediaTelemetryRequest"
  );
  assert.equal(browserMedia.parameters[0].schema.format, "uuid");

  const upload = document.paths["/admin/recordings"].post;
  assert.equal(upload.requestBody.content["multipart/form-data"].schema.properties.file.format, "binary");

  const campaignRecordingExport = document.paths["/admin/campaigns/{campaignId}/recordings.zip"].get;
  assert.equal(campaignRecordingExport.parameters[0].schema.format, "uuid");
  assert.equal(campaignRecordingExport.responses[200].content["application/zip"].schema.format, "binary");

  assert.ok(document.components.schemas.CallDetailResponse.properties.timeline);
  assert.ok(document.components.schemas.AgentDeskResponse.properties.activeCall);
  assert.ok(document.components.schemas.ErrorResponse.properties.message);

  await app.close();
});

const openApiMethods = new Set(["delete", "get", "patch", "post", "put"]);

type OpenApiOperation = {
  summary: string;
  description: string;
  parameters: Array<{ name: string; schema: TestSchema }>;
  requestBody: { content: Record<string, { schema: TestSchema }> };
  responses: Record<number, { content: Record<string, { schema: TestSchema }> }>;
};

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, TestSchema> };
};

type TestSchema = {
  $ref?: string;
  format?: string;
  properties: Record<string, TestSchema>;
};
