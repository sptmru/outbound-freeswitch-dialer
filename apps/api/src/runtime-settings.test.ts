import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { RuntimeSettingsService } from "./runtime-settings.js";

describe("RuntimeSettingsService", () => {
  it("loads persisted settings over env defaults and mutates the shared live config", async () => {
    const updatedAt = new Date("2026-07-14T12:00:00.000Z");
    const { alertmanagerSlackEnabled: _legacyMissing, ...value } = settings({
      contactMaxAttempts: 7,
      pcapCaptureEnabled: true,
      sipTrunkCallerId: "15551234567"
    });
    const pool = mockPool(async () => ({
      rows: [{ value_json: value, updated_at: updatedAt }],
      rowCount: 1
    }));
    const config = baseConfig();
    const service = new RuntimeSettingsService(pool, config, {
      reloadAlertmanager: async () => ({ ok: true, status: 200, statusText: "OK" })
    });

    await service.initialize();

    assert.equal(config.CONTACT_MAX_ATTEMPTS, 7);
    assert.equal(config.PCAP_CAPTURE_ENABLED, true);
    assert.equal(config.SIP_TRUNK_CALLER_ID, "15551234567");
    assert.equal(service.get().alertmanagerSlackEnabled, false);
    assert.equal(service.get().updatedAt, updatedAt.toISOString());
  });

  it("rejects enabling an alert channel whose deployment secret is absent", async () => {
    const pool = mockPool(async () => ({ rows: [], rowCount: 0 }));
    const service = new RuntimeSettingsService(pool, baseConfig());
    await assert.rejects(
      service.update(settings({ alertmanagerWebhookEnabled: true })),
      /Configure ALERTMANAGER_WEBHOOK_URL/
    );
    await assert.rejects(
      service.update(settings({ alertmanagerSlackEnabled: true })),
      /Configure Slack webhook URL and channel/
    );
  });

  it("renders an enabled Slack receiver with firing and resolved notifications", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-slack-settings-"));
    const configPath = join(directory, "alertmanager.yml");
    const pool = mockPool(async () => ({
      rows: [{ updated_at: new Date("2026-07-16T12:00:00.000Z") }],
      rowCount: 1
    }));
    const config = Object.assign(baseConfig(), {
      ALERTMANAGER_CONFIG_PATH: configPath,
      ALERTMANAGER_URL: "http://127.0.0.1:1",
      ALERTMANAGER_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test/example/secret",
      ALERTMANAGER_SLACK_CHANNEL: "#dialer-alerts"
    });
    const service = new RuntimeSettingsService(pool, config, {
      reloadAlertmanager: async () => ({ ok: true, status: 200, statusText: "OK" })
    });

    try {
      await service.update(settings({ alertmanagerSlackEnabled: true }));
      const rendered = await readFile(configPath, "utf8");
      assert.match(rendered, /slack_configs:/);
      assert.match(rendered, /channel: "#dialer-alerts"/);
      assert.match(rendered, /send_resolved: true/);
      assert.match(rendered, /FIRING/);
      assert.match(rendered, /RESOLVED/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists settings even while Alertmanager is temporarily unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-settings-"));
    const configPath = join(directory, "alertmanager.yml");
    const updatedAt = new Date("2026-07-14T12:30:00.000Z");
    const pool = mockPool(async () => ({ rows: [{ updated_at: updatedAt }], rowCount: 1 }));
    const config = Object.assign(baseConfig(), {
      ALERTMANAGER_CONFIG_PATH: configPath,
      ALERTMANAGER_URL: "http://127.0.0.1:1"
    });
    const service = new RuntimeSettingsService(pool, config, {
      reloadAlertmanager: async () => ({ ok: false, status: 503, statusText: "Unavailable" }),
      waitBeforeReloadRetry: async () => undefined
    });

    try {
      const updated = await service.update(settings({ contactMaxAttempts: 50 }));
      assert.equal(updated.contactMaxAttempts, 50);
      assert.equal(updated.alertmanagerApplyStatus?.state, "pending");
      assert.match(await readFile(configPath, "utf8"), /repeat_interval: 4h/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const applyStatus = service.get().alertmanagerApplyStatus;
      assert.ok(applyStatus);
      assert.deepEqual(applyStatus, {
        state: "failed",
        lastAttemptAt: applyStatus.lastAttemptAt,
        lastSuccessAt: null,
        error: "Alertmanager reload returned HTTP 503 Unavailable"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("aborts retries for a configuration superseded by a newer update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-settings-supersede-"));
    const configPath = join(directory, "alertmanager.yml");
    const pool = mockPool(async () => ({ rows: [{ updated_at: new Date() }], rowCount: 1 }));
    const config = Object.assign(baseConfig(), {
      ALERTMANAGER_CONFIG_PATH: configPath,
      ALERTMANAGER_URL: "http://127.0.0.1:1"
    });
    let reloadCalls = 0;
    let firstSignal: AbortSignal | undefined;
    const service = new RuntimeSettingsService(pool, config, {
      reloadAlertmanager: async (signal) => {
        reloadCalls += 1;
        if (reloadCalls === 1) {
          firstSignal = signal;
          return new Promise<never>(() => undefined);
        }
        return { ok: true, status: 200, statusText: "OK" };
      }
    });

    try {
      await service.update(settings({ contactMaxAttempts: 4 }));
      await service.update(settings({ contactMaxAttempts: 5 }));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(firstSignal?.aborted, true);
      assert.equal(reloadCalls, 2);
      assert.equal(service.get().alertmanagerApplyStatus?.state, "applied");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("times out a hung reload and exposes the failed apply status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-settings-timeout-"));
    const configPath = join(directory, "alertmanager.yml");
    const pool = mockPool(async () => ({ rows: [{ updated_at: new Date() }], rowCount: 1 }));
    const config = Object.assign(baseConfig(), {
      ALERTMANAGER_CONFIG_PATH: configPath,
      ALERTMANAGER_URL: "http://127.0.0.1:1"
    });
    let reloadCalls = 0;
    const service = new RuntimeSettingsService(pool, config, {
      reloadAlertmanager: async () => {
        reloadCalls += 1;
        return new Promise<never>(() => undefined);
      },
      reloadTimeoutMilliseconds: 2,
      waitBeforeReloadRetry: async () => undefined
    });

    try {
      await service.update(settings({ contactMaxAttempts: 6 }));
      await waitFor(() => service.get().alertmanagerApplyStatus?.state === "failed");

      assert.equal(reloadCalls, 10);
      assert.match(service.get().alertmanagerApplyStatus?.error ?? "", /timed out|abort/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps concurrent readers on the previous settings until persistence commits", async () => {
    let releasePersistence: (() => void) | undefined;
    let persistenceStarted: (() => void) | undefined;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const started = new Promise<void>((resolve) => {
      persistenceStarted = resolve;
    });
    const pool = mockPool(async (sql) => {
      if (sql.includes("insert into system_settings")) {
        persistenceStarted?.();
        await persistenceGate;
        return { rows: [{ updated_at: new Date("2026-07-16T15:00:00.000Z") }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const config = baseConfig();
    const service = new RuntimeSettingsService(pool, config);

    const update = service.update(settings({ contactMaxAttempts: 9 }));
    await started;
    assert.equal(config.CONTACT_MAX_ATTEMPTS, 3);
    assert.equal(service.get().contactMaxAttempts, 3);

    releasePersistence?.();
    await update;
    assert.equal(config.CONTACT_MAX_ATTEMPTS, 9);
    assert.equal(service.get().contactMaxAttempts, 9);
  });

  it("surfaces a rollback failure instead of hiding database/file divergence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-settings-rollback-failure-"));
    const configPath = join(directory, "alertmanager.yml");
    const pool = mockPool(async (sql) => {
      if (sql.trim() === "commit") {
        await rm(directory, { recursive: true, force: true });
        await writeFile(directory, "blocks recreation of the config directory");
        throw new Error("database commit failed");
      }
      if (sql.includes("insert into system_settings")) {
        return { rows: [{ updated_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const config = Object.assign(baseConfig(), {
      ALERTMANAGER_CONFIG_PATH: configPath,
      ALERTMANAGER_URL: "http://127.0.0.1:1"
    });
    const service = new RuntimeSettingsService(pool, config);

    try {
      await assert.rejects(
        service.update(settings({ contactMaxAttempts: 11 })),
        (error: unknown) =>
          error instanceof AggregateError && /config rollback also failed/.test(error.message)
      );
      assert.equal(config.CONTACT_MAX_ATTEMPTS, 3);
      assert.equal(service.get().contactMaxAttempts, 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

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
    alertmanagerSlackEnabled: false,
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
    ALERTMANAGER_SLACK_ENABLED: true,
    ALERTMANAGER_TELEGRAM_ENABLED: true
  } as AppConfig;
}

function mockPool(
  handler: (sql: string, values?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>
): pg.Pool {
  const query = (sql: string, values?: unknown[]) => handler(sql, values);
  return {
    query,
    connect: async () =>
      ({
        query,
        release: () => undefined
      }) as unknown as pg.PoolClient
  } as unknown as pg.Pool;
}
