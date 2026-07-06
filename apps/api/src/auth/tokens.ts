import { createHmac, timingSafeEqual } from "node:crypto";
import type { UserRole } from "@outbound-dialer/shared";
import type { AppConfig } from "../config.js";

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  exp: number;
}

export function signAuthToken(config: AppConfig, payload: Omit<AuthTokenPayload, "exp">): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + config.JWT_EXPIRES_SECONDS
  });
  const signature = sign(config.JWT_SECRET, `${header}.${body}`);
  return `${header}.${body}.${signature}`;
}

export function verifyAuthToken(config: AppConfig, token: string): AuthTokenPayload | null {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) {
    return null;
  }

  const expectedSignature = sign(config.JWT_SECRET, `${header}.${body}`);
  const expected = Buffer.from(expectedSignature);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AuthTokenPayload;
  if (!payload.sub || !payload.email || !payload.role || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
