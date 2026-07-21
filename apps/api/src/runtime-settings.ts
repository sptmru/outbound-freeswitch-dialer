import type pg from "pg";
import { isSupportedCountry } from "libphonenumber-js";
import { z } from "zod";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import type { AdminSystemSettings, UpdateAdminSystemSettingsRequest } from "@outbound-dialer/shared";
import type { AppConfig } from "./config.js";

export const updateSystemSettingsSchema = z.object({
  defaultPhoneCountryCode: z
    .string()
    .length(2)
    .transform((value) => value.toUpperCase())
    .refine(isSupportedCountry),
  contactMaxAttempts: z.number().int().min(1).max(100),
  contactRetryDelaySeconds: z.number().int().min(0).max(604_800),
  callHistoryExportMaxRows: z.number().int().min(100).max(250_000),
  callLogRetentionDays: z.number().int().min(1).max(3650),
  callRecordingRetentionDays: z.number().int().min(1).max(3650),
  pcapRetentionDays: z.number().int().min(1).max(365),
  retentionEnabled: z.boolean(),
  pcapCaptureEnabled: z.boolean(),
  sipTrunkCallerId: z.string().trim().max(80).nullable(),
  alertmanagerRepeatInterval: z.string().regex(/^\d+(?:s|m|h|d)$/),
  alertmanagerWebhookEnabled: z.boolean(),
  alertmanagerSlackEnabled: z.boolean(),
  alertmanagerTelegramEnabled: z.boolean()
}) satisfies z.ZodType<UpdateAdminSystemSettingsRequest>;

const persistedSystemSettingsSchema = updateSystemSettingsSchema.extend({
  alertmanagerSlackEnabled: z.boolean().default(false)
});

const SETTINGS_KEY = "admin.runtime_settings";

type ReloadResponse = Pick<Response, "ok" | "status" | "statusText">;
type RuntimeSettingsOptions = {
  now?: () => Date;
  reloadAlertmanager?: (signal?: AbortSignal) => Promise<ReloadResponse>;
  reloadTimeoutMilliseconds?: number;
  waitBeforeReloadRetry?: () => Promise<void>;
};
type StagedAlertmanagerConfig = {
  discard: () => Promise<void>;
  publish: () => Promise<void>;
};

export class RuntimeSettingsService {
  private updatedAt: string | null = null;
  private reloadGeneration = 0;
  private reloadAbortController: AbortController | null = null;
  private updateQueue: Promise<void> = Promise.resolve();
  private alertmanagerApplyStatus: NonNullable<AdminSystemSettings["alertmanagerApplyStatus"]>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig,
    private readonly options: RuntimeSettingsOptions = {}
  ) {
    this.alertmanagerApplyStatus = {
      state: config.ALERTMANAGER_CONFIG_PATH ? "pending" : "not_configured",
      lastAttemptAt: null,
      lastSuccessAt: null,
      error: null
    };
  }

  async initialize(): Promise<void> {
    const result = await this.pool.query<{ value_json: unknown; updated_at: Date }>(
      "select value_json, updated_at from system_settings where key = $1",
      [SETTINGS_KEY]
    );
    if (result.rows[0]) {
      this.apply(persistedSystemSettingsSchema.parse(result.rows[0].value_json));
      this.updatedAt = result.rows[0].updated_at.toISOString();
    }
    await this.writeAlertmanagerConfig();
    this.scheduleAlertmanagerReload();
  }

  get(): AdminSystemSettings {
    return {
      defaultPhoneCountryCode: this.config.DEFAULT_PHONE_COUNTRY_CODE,
      contactMaxAttempts: this.config.CONTACT_MAX_ATTEMPTS,
      contactRetryDelaySeconds: this.config.CONTACT_RETRY_DELAY_SECONDS,
      callHistoryExportMaxRows: this.config.CALL_HISTORY_EXPORT_MAX_ROWS,
      callLogRetentionDays: this.config.CALL_LOG_RETENTION_DAYS,
      callRecordingRetentionDays: this.config.CALL_RECORDING_RETENTION_DAYS,
      pcapRetentionDays: this.config.PCAP_RETENTION_DAYS,
      retentionEnabled: this.config.RETENTION_ENABLED,
      pcapCaptureEnabled: this.config.PCAP_CAPTURE_ENABLED,
      sipTrunkCallerId: this.config.SIP_TRUNK_CALLER_ID ?? null,
      alertmanagerRepeatInterval: this.config.ALERTMANAGER_REPEAT_INTERVAL,
      alertmanagerWebhookEnabled: this.config.ALERTMANAGER_WEBHOOK_ENABLED,
      alertmanagerSlackEnabled: this.config.ALERTMANAGER_SLACK_ENABLED,
      alertmanagerTelegramEnabled: this.config.ALERTMANAGER_TELEGRAM_ENABLED,
      availableAlertChannels: {
        webhook: Boolean(this.config.ALERTMANAGER_WEBHOOK_URL),
        slack: Boolean(this.config.ALERTMANAGER_SLACK_WEBHOOK_URL && this.config.ALERTMANAGER_SLACK_CHANNEL),
        telegram: Boolean(
          this.config.ALERTMANAGER_TELEGRAM_BOT_TOKEN && this.config.ALERTMANAGER_TELEGRAM_CHAT_ID
        )
      },
      alertmanagerApplyStatus: { ...this.alertmanagerApplyStatus },
      updatedAt: this.updatedAt
    };
  }

  update(input: UpdateAdminSystemSettingsRequest): Promise<AdminSystemSettings> {
    const operation = this.updateQueue.then(() => this.performUpdate(input));
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async performUpdate(input: UpdateAdminSystemSettingsRequest): Promise<AdminSystemSettings> {
    const value = updateSystemSettingsSchema.parse(input);
    const available = this.get().availableAlertChannels;
    if (value.alertmanagerWebhookEnabled && !available.webhook) {
      throw Object.assign(new Error("Configure ALERTMANAGER_WEBHOOK_URL before enabling webhook alerts"), {
        statusCode: 409
      });
    }
    if (value.alertmanagerSlackEnabled && !available.slack) {
      throw Object.assign(new Error("Configure Slack webhook URL and channel before enabling Slack alerts"), {
        statusCode: 409
      });
    }
    if (value.alertmanagerTelegramEnabled && !available.telegram) {
      throw Object.assign(new Error("Configure Telegram credentials before enabling Telegram alerts"), {
        statusCode: 409
      });
    }
    const candidateConfig = { ...this.config } as AppConfig;
    this.applyToConfig(candidateConfig, value);
    const stagedConfig = await this.stageAlertmanagerConfig(candidateConfig);
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      await stagedConfig?.discard();
      throw error;
    }
    let filePublished = false;
    try {
      await client.query("begin");
      const result = await client.query<{ updated_at: Date }>(
        `insert into system_settings (key, value_json, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (key) do update set value_json = excluded.value_json, updated_at = now()
         returning updated_at`,
        [SETTINGS_KEY, JSON.stringify(value)]
      );
      filePublished = Boolean(stagedConfig);
      await stagedConfig?.publish();
      await client.query("commit");
      this.apply(value);
      this.updatedAt = result.rows[0]?.updated_at.toISOString() ?? new Date().toISOString();
      this.scheduleAlertmanagerReload();
      return this.get();
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      await stagedConfig?.discard().catch(() => undefined);
      if (filePublished) {
        try {
          await this.writeAlertmanagerConfig();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Runtime settings update failed and the Alertmanager config rollback also failed"
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private apply(value: UpdateAdminSystemSettingsRequest): void {
    this.applyToConfig(this.config, value);
  }

  private applyToConfig(target: AppConfig, value: UpdateAdminSystemSettingsRequest): void {
    Object.assign(target, {
      DEFAULT_PHONE_COUNTRY_CODE: value.defaultPhoneCountryCode,
      CONTACT_MAX_ATTEMPTS: value.contactMaxAttempts,
      CONTACT_RETRY_DELAY_SECONDS: value.contactRetryDelaySeconds,
      CALL_HISTORY_EXPORT_MAX_ROWS: value.callHistoryExportMaxRows,
      CALL_LOG_RETENTION_DAYS: value.callLogRetentionDays,
      CALL_RECORDING_RETENTION_DAYS: value.callRecordingRetentionDays,
      PCAP_RETENTION_DAYS: value.pcapRetentionDays,
      RETENTION_ENABLED: value.retentionEnabled,
      PCAP_CAPTURE_ENABLED: value.pcapCaptureEnabled,
      SIP_TRUNK_CALLER_ID: value.sipTrunkCallerId || undefined,
      ALERTMANAGER_REPEAT_INTERVAL: value.alertmanagerRepeatInterval,
      ALERTMANAGER_WEBHOOK_ENABLED:
        value.alertmanagerWebhookEnabled && Boolean(this.config.ALERTMANAGER_WEBHOOK_URL),
      ALERTMANAGER_SLACK_ENABLED:
        value.alertmanagerSlackEnabled &&
        Boolean(this.config.ALERTMANAGER_SLACK_WEBHOOK_URL && this.config.ALERTMANAGER_SLACK_CHANNEL),
      ALERTMANAGER_TELEGRAM_ENABLED:
        value.alertmanagerTelegramEnabled &&
        Boolean(this.config.ALERTMANAGER_TELEGRAM_BOT_TOKEN && this.config.ALERTMANAGER_TELEGRAM_CHAT_ID)
    });
  }

  private async writeAlertmanagerConfig(): Promise<void> {
    const staged = await this.stageAlertmanagerConfig(this.config);
    if (!staged) return;
    try {
      await staged.publish();
    } catch (error) {
      await staged.discard();
      throw error;
    }
  }

  private async stageAlertmanagerConfig(config: AppConfig): Promise<StagedAlertmanagerConfig | null> {
    if (!config.ALERTMANAGER_CONFIG_PATH) return null;
    const target = config.ALERTMANAGER_CONFIG_PATH;
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, renderAlertmanager(config), { encoding: "utf8", mode: 0o640 });
      await chmod(temporary, 0o640);
      return {
        discard: () => unlink(temporary).catch(() => undefined),
        publish: async () => {
          try {
            await rename(temporary, target);
          } catch (error) {
            // Retain compatibility with legacy single-file deployments. The
            // current Compose deployment mounts the containing directory so
            // its normal path above is an atomic rename.
            if (!isFileMountRenameError(error)) throw error;
            await writeFile(target, renderAlertmanager(config), { encoding: "utf8", mode: 0o640 });
            await chmod(target, 0o640);
            await unlink(temporary).catch(() => undefined);
          }
        }
      };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private reloadAlertmanager(signal: AbortSignal): Promise<ReloadResponse> {
    const combinedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.options.reloadTimeoutMilliseconds ?? 5_000)
    ]);
    const request = this.options.reloadAlertmanager
      ? this.options.reloadAlertmanager(combinedSignal)
      : fetch(`${this.config.ALERTMANAGER_URL.replace(/\/$/, "")}/-/reload`, {
          method: "POST",
          signal: combinedSignal
        });
    return abortable(request, combinedSignal);
  }

  private scheduleAlertmanagerReload(): void {
    this.reloadAbortController?.abort(new Error("Superseded by a newer Alertmanager configuration"));
    this.reloadAbortController = null;
    if (!this.config.ALERTMANAGER_CONFIG_PATH) {
      this.reloadGeneration += 1;
      this.alertmanagerApplyStatus = {
        state: "not_configured",
        lastAttemptAt: null,
        lastSuccessAt: this.alertmanagerApplyStatus.lastSuccessAt,
        error: null
      };
      return;
    }
    const generation = ++this.reloadGeneration;
    const controller = new AbortController();
    this.reloadAbortController = controller;
    this.alertmanagerApplyStatus = {
      state: "pending",
      lastAttemptAt: this.now().toISOString(),
      lastSuccessAt: this.alertmanagerApplyStatus.lastSuccessAt,
      error: null
    };
    void this.reloadAlertmanagerEventually(generation, controller.signal);
  }

  private async reloadAlertmanagerEventually(generation: number, signal: AbortSignal): Promise<void> {
    let lastError = "Alertmanager reload did not succeed";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (generation !== this.reloadGeneration || signal.aborted) return;
      if (generation === this.reloadGeneration) {
        this.alertmanagerApplyStatus = {
          ...this.alertmanagerApplyStatus,
          lastAttemptAt: this.now().toISOString()
        };
      }
      try {
        const response = await this.reloadAlertmanager(signal);
        if (response.ok) {
          if (generation === this.reloadGeneration) {
            const appliedAt = this.now().toISOString();
            this.alertmanagerApplyStatus = {
              state: "applied",
              lastAttemptAt: this.alertmanagerApplyStatus.lastAttemptAt,
              lastSuccessAt: appliedAt,
              error: null
            };
          }
          return;
        }
        lastError = `Alertmanager reload returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      } catch (error) {
        if (generation !== this.reloadGeneration || signal.aborted) return;
        // Alertmanager may start in parallel with the API during a deployment.
        lastError = error instanceof Error ? error.message : "Alertmanager reload request failed";
      }
      if (generation !== this.reloadGeneration || signal.aborted) return;
      await this.waitBeforeReloadRetry();
    }
    if (generation === this.reloadGeneration) {
      this.alertmanagerApplyStatus = {
        state: "failed",
        lastAttemptAt: this.alertmanagerApplyStatus.lastAttemptAt,
        lastSuccessAt: this.alertmanagerApplyStatus.lastSuccessAt,
        error: lastError.slice(0, 500)
      };
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private waitBeforeReloadRetry(): Promise<void> {
    if (this.options.waitBeforeReloadRetry) return this.options.waitBeforeReloadRetry();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref();
    });
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Alertmanager reload was aborted");
}

function isFileMountRenameError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EBUSY" || error.code === "EXDEV" || error.code === "EPERM")
  );
}

function renderAlertmanager(config: AppConfig): string {
  const integrations: string[] = [];
  if (config.ALERTMANAGER_WEBHOOK_ENABLED && config.ALERTMANAGER_WEBHOOK_URL) {
    integrations.push(
      `    webhook_configs:\n      - url: ${JSON.stringify(config.ALERTMANAGER_WEBHOOK_URL)}\n        send_resolved: true`
    );
  }
  if (
    config.ALERTMANAGER_SLACK_ENABLED &&
    config.ALERTMANAGER_SLACK_WEBHOOK_URL &&
    config.ALERTMANAGER_SLACK_CHANNEL
  ) {
    integrations.push(
      renderSlackConfig(config.ALERTMANAGER_SLACK_WEBHOOK_URL, config.ALERTMANAGER_SLACK_CHANNEL)
    );
  }
  if (
    config.ALERTMANAGER_TELEGRAM_ENABLED &&
    config.ALERTMANAGER_TELEGRAM_BOT_TOKEN &&
    config.ALERTMANAGER_TELEGRAM_CHAT_ID
  ) {
    integrations.push(
      `    telegram_configs:\n      - bot_token: ${JSON.stringify(config.ALERTMANAGER_TELEGRAM_BOT_TOKEN)}\n        chat_id: ${config.ALERTMANAGER_TELEGRAM_CHAT_ID}\n        send_resolved: true\n        parse_mode: HTML`
    );
  }
  return `global:\n  resolve_timeout: 5m\n\nroute:\n  receiver: default\n  group_by: [alertname, severity]\n  group_wait: 30s\n  group_interval: 5m\n  repeat_interval: ${config.ALERTMANAGER_REPEAT_INTERVAL}\n  routes:\n    - receiver: default\n      matchers:\n        - alertname="DeploymentStarting"\n      group_wait: 0s\n      group_interval: 5m\n      repeat_interval: 1h\n\nreceivers:\n  - name: default\n${integrations.length ? `${integrations.join("\n")}\n` : ""}\ninhibit_rules:\n  - source_matchers:\n      - severity="critical"\n    target_matchers:\n      - severity="warning"\n    equal: [alertname]\n`;
}

function renderSlackConfig(webhookUrl: string, channel: string): string {
  return `    slack_configs:\n      - api_url: ${JSON.stringify(webhookUrl)}\n        channel: ${JSON.stringify(channel)}\n        send_resolved: true\n        color: '{{ if eq .Status "firing" }}danger{{ else }}good{{ end }}'\n        title: '{{ if eq .Status "firing" }}FIRING{{ else }}RESOLVED{{ end }}: {{ .CommonLabels.alertname }}'\n        text: '{{ range .Alerts }}{{ .Annotations.summary }}{{ if .Annotations.description }} - {{ .Annotations.description }}{{ end }}{{ "\\n" }}{{ end }}'`;
}
