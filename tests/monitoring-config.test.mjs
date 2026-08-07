import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderAlertmanager } from "../scripts/render-monitoring-config.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("monitoring renderer creates the atomically replaceable Alertmanager directory", async () => {
  const output = await mkdtemp(join(tmpdir(), "outbound-dialer-monitoring-render-"));
  try {
    const rendered = spawnSync(
      process.execPath,
      [join(root, "scripts/render-monitoring-config.mjs"), output],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          LETSENCRYPT_DOMAIN: "dialer.example.test",
          GRAFANA_DOMAIN: "grafana.example.test",
          GRAFANA_ADMIN_PASSWORD: "test-password-at-least-16"
        }
      }
    );
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
    assert.match(await readFile(join(output, "alertmanager", "alertmanager.yml"), "utf8"), /route:/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("monitoring config renders a native Slack receiver", () => {
  const rendered = renderAlertmanager({
    ALERTMANAGER_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test/example/secret",
    ALERTMANAGER_SLACK_CHANNEL: "#dialer-alerts"
  });

  assert.match(rendered, /slack_configs:/);
  assert.match(rendered, /channel: "#dialer-alerts"/);
  assert.match(rendered, /send_resolved: true/);
  assert.match(rendered, /FIRING/);
  assert.match(rendered, /RESOLVED/);
});

test("deployment alerts bypass the ordinary Alertmanager group wait", () => {
  const rendered = renderAlertmanager({});

  assert.ok(
    rendered.includes(
      'routes:\n    - receiver: default\n      matchers:\n        - alertname="DeploymentStarting"\n      group_wait: 0s'
    )
  );
});

test("monitoring config rejects incomplete or insecure Slack settings", () => {
  assert.throws(
    () => renderAlertmanager({ ALERTMANAGER_SLACK_CHANNEL: "#dialer-alerts" }),
    /Set both ALERTMANAGER_SLACK_WEBHOOK_URL and ALERTMANAGER_SLACK_CHANNEL/
  );
  assert.throws(
    () =>
      renderAlertmanager({
        ALERTMANAGER_SLACK_WEBHOOK_URL: "http://hooks.slack.test/services/example",
        ALERTMANAGER_SLACK_CHANNEL: "#dialer-alerts"
      }),
    /ALERTMANAGER_SLACK_WEBHOOK_URL must use https/
  );
});

test("log ingestion drops replayed entries before Loki rejects their batch", () => {
  const alloy = readFileSync(join(root, "monitoring/alloy/config.alloy"), "utf8");
  const loki = readFileSync(join(root, "monitoring/loki/loki.yml"), "utf8");

  const alloyDropHours = Number(alloy.match(/older_than\s+=\s+"(\d+)h"/)?.[1]);
  const lokiRejectHours = Number(loki.match(/reject_old_samples_max_age:\s+(\d+)h/)?.[1]);

  assert.match(alloy, /drop_counter_reason = "outside_loki_ingestion_window"/);
  assert.match(loki, /reject_old_samples:\s+true/);
  assert.ok(Number.isFinite(alloyDropHours));
  assert.ok(Number.isFinite(lokiRejectHours));
  assert.ok(alloyDropHours < lokiRejectHours);
  assert.equal(lokiRejectHours - alloyDropHours, 1);
});

test("monitoring dashboard provisions the application link and PCAP panels", () => {
  const dashboard = JSON.parse(
    readFileSync(join(root, "monitoring/grafana/dashboards/outbound-dialer-overview.json"), "utf8")
  );
  const renderer = readFileSync(join(root, "scripts/render-monitoring-config.mjs"), "utf8");

  assert.equal(dashboard.links[0].url, "https://__APP_DOMAIN__/call-history");
  assert.match(renderer, /replaceAll\("__APP_DOMAIN__", appDomain\)/);
  assert.match(renderer, /resolve\(outputDirectory, "alertmanager"\)/);
  assert.deepEqual(
    dashboard.panels.filter((panel) => panel.id >= 12 && panel.id <= 16).map((panel) => panel.title),
    [
      "PCAP capture",
      "PCAP captures active",
      "PCAP failures (24h)",
      "PCAP storage",
      "Recent PCAP capture events"
    ]
  );
});

test("monitoring dashboard includes FreeSWITCH runtime counters", () => {
  const dashboard = JSON.parse(
    readFileSync(join(root, "monitoring/grafana/dashboards/outbound-dialer-overview.json"), "utf8")
  );
  const panels = new Map(dashboard.panels.map((panel) => [panel.title, panel]));

  assert.equal(
    panels.get("FreeSWITCH active channels")?.targets[0]?.expr,
    "outbound_dialer_freeswitch_active_channels"
  );
  assert.equal(
    panels.get("FreeSWITCH registrations")?.targets[0]?.expr,
    "outbound_dialer_freeswitch_registrations"
  );
});

test("monitoring dashboard exposes API, persistence, media, and operations signals", () => {
  const dashboard = JSON.parse(
    readFileSync(join(root, "monitoring/grafana/dashboards/outbound-dialer-overview.json"), "utf8")
  );
  const panels = new Map(dashboard.panels.map((panel) => [panel.title, panel]));

  assert.match(
    panels.get("API latency")?.targets[0]?.expr ?? "",
    /histogram_quantile\(0\.95,.*outbound_dialer_http_request_duration_seconds_bucket/
  );
  assert.match(
    panels.get("API latency")?.targets[1]?.expr ?? "",
    /histogram_quantile\(0\.99,.*outbound_dialer_http_request_duration_seconds_bucket/
  );
  assert.match(panels.get("API 5xx ratio")?.targets[0]?.expr ?? "", /status_class="5xx"/);
  assert.deepEqual(
    panels.get("ESL persistence queue")?.targets.map((target) => target.legendFormat),
    ["Depth", "Capacity", "Utilization"]
  );
  assert.deepEqual(
    panels.get("ESL reliability")?.targets.map((target) => target.legendFormat),
    ["Retries (15m)", "Overflows (15m)", "Persistence errors (15m)", "Reconnects (15m)"]
  );
  assert.equal(
    panels.get("Outcome distribution (24h)")?.targets[0]?.expr,
    "outbound_dialer_call_outcomes_window"
  );
  assert.equal(
    panels.get("Metrics database snapshot")?.targets[0]?.expr,
    "outbound_dialer_database_metrics_up"
  );
  assert.equal(
    panels.get("Recording finalization backlog")?.targets[0]?.expr,
    "outbound_dialer_recording_finalization_backlog"
  );
  assert.equal(panels.get("Backup age")?.targets[0]?.instant, true);
  assert.equal(panels.get("TLS certificate remaining")?.targets[0]?.instant, true);
  assert.equal(panels.get("Retention age")?.targets[0]?.instant, true);
  assert.equal(panels.get("Container restarts (15m)")?.targets[0]?.instant, true);
});

test("monitoring dashboard exposes bounded call-quality and reconciliation signals", () => {
  const dashboard = JSON.parse(
    readFileSync(join(root, "monitoring/grafana/dashboards/outbound-dialer-overview.json"), "utf8")
  );
  const panels = new Map(dashboard.panels.map((panel) => [panel.title, panel]));

  assert.equal(
    panels.get("Media stats coverage (15m)")?.targets[0]?.expr ?? "",
    '100 * sum(outbound_dialer_media_quality_calls_window{coverage="complete"}) / clamp_min(sum(outbound_dialer_media_quality_calls_window{coverage="eligible"}), 1)'
  );
  assert.equal(
    panels.get("Suspected one-way audio by leg")?.targets[0]?.expr,
    "outbound_dialer_media_one_way_suspected_calls_window"
  );
  assert.equal(
    panels.get("Negotiated codecs (15m)")?.targets[0]?.expr,
    "outbound_dialer_media_codecs_window"
  );
  assert.equal(
    panels.get("Terminal finalization latency (15m)")?.targets[0]?.expr,
    "outbound_dialer_terminal_finalization_duration_milliseconds"
  );
  assert.match(
    panels.get("Registration reconciliation detail")?.targets[0]?.expr ?? "",
    /registration_reconciliation_last_run_timestamp_seconds/
  );
  assert.match(
    panels.get("Active-call reconciliation detail")?.targets[0]?.expr ?? "",
    /active_call_reconciliation_last_run_timestamp_seconds/
  );
});

test("new monitoring alerts require sustained failures or guarded samples", () => {
  const rules = readFileSync(join(root, "monitoring/prometheus/rules.yml"), "utf8");

  assert.match(rules, /alert: RegistrationReconciliationFailing[\s\S]*?for: 1m/);
  assert.match(rules, /alert: RegistrationReconciliationStale[\s\S]*?> 30[\s\S]*?for: 1m/);
  assert.match(rules, /alert: ActiveCallReconciliationFailing[\s\S]*?for: 5m/);
  assert.match(rules, /alert: ActiveCallReconciliationStale[\s\S]*?> 180[\s\S]*?for: 5m/);
  assert.match(rules, /alert: MediaStatsCoverageLow[\s\S]*?coverage="eligible"\}\) >= 10[\s\S]*?for: 15m/);
  assert.match(
    rules,
    /alert: TerminalFinalizationSlow[\s\S]*?terminal_finalization_samples_window >= 10[\s\S]*?for: 10m/
  );
});

test("monitoring dashboard current-state cards use instant Prometheus queries", () => {
  const dashboard = JSON.parse(
    readFileSync(join(root, "monitoring/grafana/dashboards/outbound-dialer-overview.json"), "utf8")
  );
  const currentStateTitles = [
    "External availability",
    "FreeSWITCH ESL",
    "SIP trunk",
    "Active calls",
    "Registered agents",
    "Stuck calls",
    "FreeSWITCH active channels",
    "FreeSWITCH registrations",
    "Metrics database snapshot",
    "Voicemail jobs active",
    "Stuck voicemail jobs",
    "Recording finalization backlog",
    "Backup age",
    "TLS certificate remaining",
    "Retention age",
    "Container restarts (15m)",
    "Media stats coverage (15m)",
    "Suspected one-way audio (15m)",
    "Registration reconciliation",
    "Active-call reconciliation"
  ];
  const panels = new Map(dashboard.panels.map((panel) => [panel.title, panel]));

  for (const title of currentStateTitles) {
    const target = panels.get(title)?.targets[0];
    assert.equal(target?.instant, true, `${title} must be instant`);
    assert.equal(target?.range, false, `${title} must not run as a range query`);
  }
});

test("only Prometheus receives the lifecycle feature flag", () => {
  const compose = readFileSync(join(root, "infra/docker/docker-compose.yml"), "utf8");
  const prometheus = compose.slice(compose.indexOf("  prometheus:"), compose.indexOf("  alertmanager:"));
  const alertmanager = compose.slice(compose.indexOf("  alertmanager:"), compose.indexOf("  grafana:"));

  assert.match(prometheus, /--web\.enable-lifecycle/);
  assert.doesNotMatch(alertmanager, /--web\.enable-lifecycle/);
});
