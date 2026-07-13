import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "./config.js";
import { decryptSecret, encryptSecret, secretNeedsReencryption } from "./auth/crypto.js";

describe("SIP credential encryption", () => {
  it("keeps first-stage dual-read deployments rollback-compatible", () => {
    const staged = {
      JWT_SECRET: "legacy-jwt-secret-that-is-at-least-32-bytes",
      SIP_SECRET_ENCRYPTION_KEY: "independent-sip-key-that-is-at-least-32-bytes",
      SIP_SECRET_WRITE_VERSION: "v1"
    } as AppConfig;

    const encrypted = encryptSecret(staged, "sip-password");

    assert.match(encrypted, /^v1\./);
    assert.equal(secretNeedsReencryption(staged, encrypted), false);
  });

  it("keeps legacy v1 credentials readable while writing new v2 credentials with the dedicated key", () => {
    const legacyConfig = {
      JWT_SECRET: "legacy-jwt-secret-that-is-at-least-32-bytes"
    } as AppConfig;
    const legacy = encryptSecret(legacyConfig, "sip-password");
    assert.match(legacy, /^v1\./);

    const migratedConfig = {
      ...legacyConfig,
      SIP_SECRET_ENCRYPTION_KEY: "independent-sip-key-that-is-at-least-32-bytes",
      SIP_SECRET_WRITE_VERSION: "v2"
    } as AppConfig;
    assert.equal(decryptSecret(migratedConfig, legacy), "sip-password");
    assert.equal(secretNeedsReencryption(migratedConfig, legacy), true);

    const current = encryptSecret(migratedConfig, "sip-password");
    assert.match(current, /^v2\./);
    assert.equal(decryptSecret(migratedConfig, current), "sip-password");
    assert.equal(secretNeedsReencryption(migratedConfig, current), false);
  });

  it("does not tie v2 credentials to JWT rotation", () => {
    const original = {
      JWT_SECRET: "original-jwt-secret-that-is-at-least-32-bytes",
      SIP_SECRET_ENCRYPTION_KEY: "independent-sip-key-that-is-at-least-32-bytes",
      SIP_SECRET_WRITE_VERSION: "v2"
    } as AppConfig;
    const encrypted = encryptSecret(original, "sip-password");
    const rotated = {
      ...original,
      JWT_SECRET: "rotated-jwt-secret-that-is-at-least-32-bytes"
    } as AppConfig;
    assert.equal(decryptSecret(rotated, encrypted), "sip-password");
  });
});
