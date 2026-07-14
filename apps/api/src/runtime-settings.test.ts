import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { RuntimeSettingsService } from "./runtime-settings.js";

describe("RuntimeSettingsService", () => {
  it("loads persisted settings over env defaults and mutates the shared live config", async () => {
    const updatedAt = new Date("2026-07-14T12:00:00.000Z");
    const value = settings({
      contactMaxAttempts: 7,
      pcapCaptureEnabled: true,
      sipTrunkCallerId: "15551234567"
    });
    const pool = {
      query: async () => ({ rows: [{ value_json: value, updated_at: updatedAt }], rowCount: 1 })
    } as unknown as pg.Pool;
    const config = baseConfig();
    const service = new RuntimeSettingsService(pool, config);

    await service.initialize();

    assert.equal(config.CONTACT_MAX_ATTEMPTS, 7);
    assert.equal(config.PCAP_CAPTURE_ENABLED, true);
    assert.equal(config.SIP_TRUNK_CALLER_ID, "15551234567");
    assert.equal(service.get().updatedAt, updatedAt.toISOString());
  });

  it("rejects enabling an alert channel whose deployment secret is absent", async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as pg.Pool;
    const service = new RuntimeSettingsService(pool, baseConfig());
    await assert.rejects(
      service.update(settings({ alertmanagerWebhookEnabled: true })),
      /Configure ALERTMANAGER_WEBHOOK_URL/
    );
  });

  it("persists settings even while Alertmanager is temporarily unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-settings-"));
    const configPath = join(directory, "alertmanager.yml");
    const updatedAt = new Date("2026-07-14T12:30:00.000Z");
    const pool = {
      query: async () => ({ rows: [{ updated_at: updatedAt }], rowCount: 1 })
    } as unknown as pg.Pool;
    const config = Object.assign(baseConfig(), {
      ALERTMANAGER_CONFIG_PATH: configPath,
      ALERTMANAGER_URL: "http://127.0.0.1:1"
    });
    const service = new RuntimeSettingsService(pool, config);

    try {
      const updated = await service.update(settings({ contactMaxAttempts: 50 }));
      assert.equal(updated.contactMaxAttempts, 50);
      assert.match(await readFile(configPath, "utf8"), /repeat_interval: 4h/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function settings(overrides: Record<string, unknown> = {}) {
  return {
    defaultPhoneCountryCode: "US",
    contactMaxAttempts: 3,
    contactRetryDelaySeconds: 900,
    callHistoryExportMaxRows: 50_000,
    callLogRetentionDays: 7,
    callRecordingRetentionDays: 30,
    pcapRetentionDays: 7,
    retentionEnabled: true,
    pcapCaptureEnabled: false,
    sipTrunkCallerId: null,
    alertmanagerRepeatInterval: "4h",
    alertmanagerWebhookEnabled: false,
    alertmanagerTelegramEnabled: false,
    ...overrides
  };
}

function baseConfig(): AppConfig {
  return {
    DEFAULT_PHONE_COUNTRY_CODE: "US",
    CONTACT_MAX_ATTEMPTS: 3,
    CONTACT_RETRY_DELAY_SECONDS: 900,
    CALL_HISTORY_EXPORT_MAX_ROWS: 50_000,
    CALL_LOG_RETENTION_DAYS: 7,
    CALL_RECORDING_RETENTION_DAYS: 30,
    PCAP_RETENTION_DAYS: 7,
    RETENTION_ENABLED: true,
    PCAP_CAPTURE_ENABLED: false,
    ALERTMANAGER_REPEAT_INTERVAL: "4h",
    ALERTMANAGER_WEBHOOK_ENABLED: true,
    ALERTMANAGER_TELEGRAM_ENABLED: true
  } as AppConfig;
}
