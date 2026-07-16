#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

async function main() {
  const outputDirectory = resolve(process.argv[2] ?? "monitoring/generated");
  const appDomain = required("LETSENCRYPT_DOMAIN");
  const grafanaDomain = required("GRAFANA_DOMAIN");
  const grafanaPassword = required("GRAFANA_ADMIN_PASSWORD");

  if (appDomain === grafanaDomain) {
    throw new Error("GRAFANA_DOMAIN must be different from LETSENCRYPT_DOMAIN");
  }
  if (grafanaPassword.length < 16 || grafanaPassword === "change-me-long-random-grafana-password") {
    throw new Error("GRAFANA_ADMIN_PASSWORD must be a non-default value with at least 16 characters");
  }

  await mkdir(outputDirectory, { recursive: true });

  const prometheusTemplate = await readFile(resolve("monitoring/prometheus/prometheus.yml.tpl"), "utf8");
  const prometheus = prometheusTemplate
    .replaceAll("__APP_READY_URL__", `https://${appDomain}/api/health/ready`)
    .replaceAll("__GRAFANA_HEALTH_URL__", `https://${grafanaDomain}/api/health`);

  await writeFile(resolve(outputDirectory, "prometheus.yml"), prometheus, { mode: 0o644 });
  const grafanaDashboardTemplate = await readFile(
    resolve("monitoring/grafana/dashboards/outbound-dialer-overview.json"),
    "utf8"
  );
  const grafanaDashboard = grafanaDashboardTemplate.replaceAll("__APP_DOMAIN__", appDomain);
  await writeFile(resolve(outputDirectory, "outbound-dialer-overview.json"), grafanaDashboard, {
    mode: 0o644
  });
  const alertmanagerPath = resolve(outputDirectory, "alertmanager.yml");
  await writeFile(alertmanagerPath, renderAlertmanager(), { mode: 0o640 });
  await chmod(alertmanagerPath, 0o640);

  console.log(`Rendered monitoring configuration for ${appDomain} and ${grafanaDomain}`);
}

export function renderAlertmanager(env = process.env) {
  const repeatInterval = env.ALERTMANAGER_REPEAT_INTERVAL?.trim() || "4h";
  const integrations = [];
  const webhookUrl = env.ALERTMANAGER_WEBHOOK_URL?.trim();
  const slackWebhookUrl = env.ALERTMANAGER_SLACK_WEBHOOK_URL?.trim();
  const slackChannel = env.ALERTMANAGER_SLACK_CHANNEL?.trim();
  const telegramToken = env.ALERTMANAGER_TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = env.ALERTMANAGER_TELEGRAM_CHAT_ID?.trim();

  if (webhookUrl) {
    const parsed = new URL(webhookUrl);
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("ALERTMANAGER_WEBHOOK_URL must use http or https");
    }
    integrations.push(
      `    webhook_configs:\n      - url: ${yamlString(webhookUrl)}\n        send_resolved: true`
    );
  }

  if (slackWebhookUrl || slackChannel) {
    if (!slackWebhookUrl || !slackChannel) {
      throw new Error("Set both ALERTMANAGER_SLACK_WEBHOOK_URL and ALERTMANAGER_SLACK_CHANNEL");
    }
    const parsed = new URL(slackWebhookUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("ALERTMANAGER_SLACK_WEBHOOK_URL must use https");
    }
    integrations.push(renderSlackConfig(slackWebhookUrl, slackChannel));
  }

  if (telegramToken || telegramChatId) {
    if (!telegramToken || !telegramChatId) {
      throw new Error("Set both ALERTMANAGER_TELEGRAM_BOT_TOKEN and ALERTMANAGER_TELEGRAM_CHAT_ID");
    }
    if (!/^-?\d+$/.test(telegramChatId)) {
      throw new Error("ALERTMANAGER_TELEGRAM_CHAT_ID must be an integer");
    }
    integrations.push(
      `    telegram_configs:\n      - bot_token: ${yamlString(telegramToken)}\n        chat_id: ${telegramChatId}\n        send_resolved: true\n        parse_mode: HTML`
    );
  }

  return `global:
  resolve_timeout: 5m

route:
  receiver: default
  group_by: [alertname, severity]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: ${repeatInterval}

receivers:
  - name: default
${integrations.length ? `${integrations.join("\n")}\n` : ""}
inhibit_rules:
  - source_matchers:
      - severity="critical"
    target_matchers:
      - severity="warning"
    equal: [alertname]
`;
}

function renderSlackConfig(webhookUrl, channel) {
  return `    slack_configs:\n      - api_url: ${yamlString(webhookUrl)}\n        channel: ${yamlString(channel)}\n        send_resolved: true\n        color: '{{ if eq .Status "firing" }}danger{{ else }}good{{ end }}'\n        title: '{{ if eq .Status "firing" }}FIRING{{ else }}RESOLVED{{ end }}: {{ .CommonLabels.alertname }}'\n        text: '{{ range .Alerts }}{{ .Annotations.summary }}{{ if .Annotations.description }} - {{ .Annotations.description }}{{ end }}{{ "\\n" }}{{ end }}'`;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

function yamlString(value) {
  return JSON.stringify(value);
}
