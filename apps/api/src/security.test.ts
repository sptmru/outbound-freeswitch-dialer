import assert from "node:assert/strict";
import { describe, it } from "node:test";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import type { AppConfig } from "./config.js";
import {
  isTrustedProxyAddress,
  registerCookieCsrfProtection,
  registerLoginRateLimit,
  sanitizeRequestUrl,
  SESSION_COOKIE_NAME
} from "./security.js";

describe("request log redaction", () => {
  it("removes query strings containing media tickets and other secrets", () => {
    assert.equal(
      sanitizeRequestUrl("/admin/recordings/id/audio?ticket=secret&other=value"),
      "/admin/recordings/id/audio"
    );
    assert.equal(sanitizeRequestUrl("/health/ready"), "/health/ready");
    assert.equal(sanitizeRequestUrl(undefined), "");
  });
});

describe("login rate limiting", () => {
  it("returns 429 with Retry-After after the configured attempt limit", async () => {
    const app = Fastify();
    registerLoginRateLimit(app, {
      LOGIN_RATE_LIMIT_MAX: 2,
      LOGIN_RATE_LIMIT_WINDOW_SECONDS: 60
    } as AppConfig);
    app.post("/auth/login", async () => ({ ok: true }));

    try {
      assert.equal((await app.inject({ method: "POST", url: "/auth/login" })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/auth/login" })).statusCode, 200);
      const blocked = await app.inject({ method: "POST", url: "/auth/login" });
      assert.equal(blocked.statusCode, 429);
      assert.ok(Number(blocked.headers["retry-after"]) > 0);
    } finally {
      await app.close();
    }
  });

  it("uses a forwarded client address only when the direct peer is a trusted proxy", async () => {
    const app = Fastify({ trustProxy: isTrustedProxyAddress });
    registerLoginRateLimit(app, {
      LOGIN_RATE_LIMIT_MAX: 1,
      LOGIN_RATE_LIMIT_WINDOW_SECONDS: 60
    } as AppConfig);
    app.post("/auth/login", async () => ({ ok: true }));

    try {
      const first = await app.inject({
        headers: { "x-forwarded-for": "203.0.113.10" },
        method: "POST",
        remoteAddress: "172.18.0.2",
        url: "/auth/login"
      });
      const second = await app.inject({
        headers: { "x-forwarded-for": "203.0.113.11" },
        method: "POST",
        remoteAddress: "172.18.0.2",
        url: "/auth/login"
      });
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);

      const direct = await app.inject({
        headers: { "x-forwarded-for": "203.0.113.20" },
        method: "POST",
        remoteAddress: "198.51.100.5",
        url: "/auth/login"
      });
      const spoofed = await app.inject({
        headers: { "x-forwarded-for": "203.0.113.21" },
        method: "POST",
        remoteAddress: "198.51.100.5",
        url: "/auth/login"
      });
      assert.equal(direct.statusCode, 200);
      assert.equal(spoofed.statusCode, 429);
    } finally {
      await app.close();
    }
  });
});

describe("cookie CSRF protection", () => {
  it("requires an allowed Origin for unsafe cookie-authenticated requests", async () => {
    const app = Fastify();
    await app.register(cookie);
    registerCookieCsrfProtection(app, {
      PUBLIC_APP_URL: "https://dialer.example.com",
      corsOrigins: ["http://localhost:5173"]
    } as AppConfig);
    app.post("/mutation", async () => ({ ok: true }));
    const cookieHeader = `${SESSION_COOKIE_NAME}=session-token`;

    try {
      assert.equal(
        (
          await app.inject({
            headers: { cookie: cookieHeader, origin: "https://dialer.example.com" },
            method: "POST",
            url: "/mutation"
          })
        ).statusCode,
        200
      );
      assert.equal(
        (
          await app.inject({
            headers: { cookie: cookieHeader, origin: "https://evil.example" },
            method: "POST",
            url: "/mutation"
          })
        ).statusCode,
        403
      );
      assert.equal(
        (await app.inject({ headers: { cookie: cookieHeader }, method: "POST", url: "/mutation" }))
          .statusCode,
        403
      );
      assert.equal(
        (
          await app.inject({
            headers: { authorization: "Bearer api-token", cookie: cookieHeader },
            method: "POST",
            url: "/mutation"
          })
        ).statusCode,
        200
      );
    } finally {
      await app.close();
    }
  });
});
