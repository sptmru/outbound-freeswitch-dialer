#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
const alertmanagerPath = resolve(outputDirectory, "alertmanager.yml");
await writeFile(alertmanagerPath, renderAlertmanager(), { mode: 0o644 });
await chmod(alertmanagerPath, 0o644);

console.log(`Rendered monitoring configuration for ${appDomain} and ${grafanaDomain}`);

function renderAlertmanager() {
  const repeatInterval = process.env.ALERTMANAGER_REPEAT_INTERVAL?.trim() || "4h";
  const integrations = [];
  const webhookUrl = process.env.ALERTMANAGER_WEBHOOK_URL?.trim();
  const telegramToken = process.env.ALERTMANAGER_TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = process.env.ALERTMANAGER_TELEGRAM_CHAT_ID?.trim();

  if (webhookUrl) {
    const parsed = new URL(webhookUrl);
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("ALERTMANAGER_WEBHOOK_URL must use http or https");
    }
    integrations.push(`    webhook_configs:\n      - url: ${yamlString(webhookUrl)}\n        send_resolved: true`);
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
