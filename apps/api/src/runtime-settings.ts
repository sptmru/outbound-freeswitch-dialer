import type pg from "pg";
import { isSupportedCountry } from "libphonenumber-js";
import { z } from "zod";
import { chmod, writeFile } from "node:fs/promises";
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

export class RuntimeSettingsService {
  private updatedAt: string | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig
  ) {}

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
    if (this.config.ALERTMANAGER_CONFIG_PATH) void this.reloadAlertmanagerEventually();
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
      updatedAt: this.updatedAt
    };
  }

  async update(input: UpdateAdminSystemSettingsRequest): Promise<AdminSystemSettings> {
    const value = updateSystemSettingsSchema.parse(input);
    const previous = this.get();
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
    this.apply(value);
    try {
      await this.writeAlertmanagerConfig();
      const result = await this.pool.query<{ updated_at: Date }>(
        `insert into system_settings (key, value_json, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (key) do update set value_json = excluded.value_json, updated_at = now()
         returning updated_at`,
        [SETTINGS_KEY, JSON.stringify(value)]
      );
      this.updatedAt = result.rows[0]?.updated_at.toISOString() ?? new Date().toISOString();
      if (this.config.ALERTMANAGER_CONFIG_PATH) void this.reloadAlertmanagerEventually();
      return this.get();
    } catch (error) {
      const { availableAlertChannels: _available, updatedAt: _updatedAt, ...rollback } = previous;
      this.apply(rollback);
      await this.writeAlertmanagerConfig().catch(() => undefined);
      throw error;
    }
  }

  private apply(value: UpdateAdminSystemSettingsRequest): void {
    Object.assign(this.config, {
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
    if (!this.config.ALERTMANAGER_CONFIG_PATH) return;
    await writeFile(this.config.ALERTMANAGER_CONFIG_PATH, renderAlertmanager(this.config), "utf8");
    await chmod(this.config.ALERTMANAGER_CONFIG_PATH, 0o640);
  }

  private reloadAlertmanager(): Promise<Response> {
    return fetch(`${this.config.ALERTMANAGER_URL.replace(/\/$/, "")}/-/reload`, { method: "POST" });
  }

  private async reloadAlertmanagerEventually(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        if ((await this.reloadAlertmanager()).ok) return;
      } catch {
        // Alertmanager may start in parallel with the API during a deployment.
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
      });
    }
  }
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
  return `global:\n  resolve_timeout: 5m\n\nroute:\n  receiver: default\n  group_by: [alertname, severity]\n  group_wait: 30s\n  group_interval: 5m\n  repeat_interval: ${config.ALERTMANAGER_REPEAT_INTERVAL}\n\nreceivers:\n  - name: default\n${integrations.length ? `${integrations.join("\n")}\n` : ""}\ninhibit_rules:\n  - source_matchers:\n      - severity="critical"\n    target_matchers:\n      - severity="warning"\n    equal: [alertname]\n`;
}

function renderSlackConfig(webhookUrl: string, channel: string): string {
  return `    slack_configs:\n      - api_url: ${JSON.stringify(webhookUrl)}\n        channel: ${JSON.stringify(channel)}\n        send_resolved: true\n        color: '{{ if eq .Status "firing" }}danger{{ else }}good{{ end }}'\n        title: '{{ if eq .Status "firing" }}FIRING{{ else }}RESOLVED{{ end }}: {{ .CommonLabels.alertname }}'\n        text: '{{ range .Alerts }}{{ .Annotations.summary }}{{ if .Annotations.description }} - {{ .Annotations.description }}{{ end }}{{ "\\n" }}{{ end }}'`;
}
