import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerApiDocumentation } from "./api-documentation.js";

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
  assert.equal(document.openapi, "3.0.3");
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
