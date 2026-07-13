import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

export const SESSION_COOKIE_NAME = "outbound_dialer_session";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Request query strings may contain short-lived media tickets and must never be
 * copied into application logs. Keep only the path, including for malformed
 * or relative request targets.
 */
export function sanitizeRequestUrl(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value.split("?", 1)[0] ?? "";
}

type AttemptWindow = {
  count: number;
  resetAt: number;
};

export function registerLoginRateLimit(app: FastifyInstance, config: AppConfig): void {
  const attempts = new Map<string, AttemptWindow>();
  const windowMilliseconds = config.LOGIN_RATE_LIMIT_WINDOW_SECONDS * 1000;

  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST" || request.url.split("?", 1)[0] !== "/auth/login") {
      return;
    }

    const now = Date.now();
    const key = request.ip;
    const current = attempts.get(key);
    const window =
      !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMilliseconds } : current;
    window.count += 1;
    attempts.set(key, window);

    reply.header("X-RateLimit-Limit", config.LOGIN_RATE_LIMIT_MAX);
    reply.header("X-RateLimit-Remaining", Math.max(0, config.LOGIN_RATE_LIMIT_MAX - window.count));
    reply.header("X-RateLimit-Reset", Math.ceil(window.resetAt / 1000));

    if (window.count > config.LOGIN_RATE_LIMIT_MAX) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
      return reply.header("Retry-After", retryAfter).code(429).send({
        message: "Too many login attempts. Try again later."
      });
    }

    if (attempts.size > 10_000) {
      for (const [attemptKey, attempt] of attempts) {
        if (attempt.resetAt <= now) {
          attempts.delete(attemptKey);
        }
      }
    }
  });
}

/**
 * Cookie-authenticated browser mutations must come from one of the configured
 * application origins. Bearer-authenticated API clients are not susceptible to
 * ambient-cookie CSRF and remain supported without an Origin header.
 */
export function registerCookieCsrfProtection(app: FastifyInstance, config: AppConfig): void {
  const allowedOrigins = new Set(
    [config.PUBLIC_APP_URL, ...config.corsOrigins]
      .map(toOrigin)
      .filter((origin): origin is string => Boolean(origin))
  );

  app.addHook("onRequest", async (request, reply) => {
    if (safeMethods.has(request.method) || request.headers.authorization?.startsWith("Bearer ")) {
      return;
    }
    if (!request.cookies[SESSION_COOKIE_NAME]) {
      return;
    }

    const origin = request.headers.origin;
    if (!origin || !allowedOrigins.has(toOrigin(origin) ?? "")) {
      return reply.code(403).send({ message: "Request origin is not allowed" });
    }
  });
}

/**
 * The API is reached through the compose nginx proxy in production. Trust only
 * loopback/private/link-local peers so public clients cannot spoof X-Forwarded-For
 * when they reach the API directly.
 */
export function isTrustedProxyAddress(address: string): boolean {
  const normalized = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address.toLowerCase();
  const addressFamily = isIP(normalized);
  if (!addressFamily) {
    return false;
  }
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (
    addressFamily === 6 &&
    (normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb"))
  ) {
    return true;
  }

  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function toOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
