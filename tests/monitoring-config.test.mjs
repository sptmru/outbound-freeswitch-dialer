import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("monitoring dashboard provisions the application link and PCAP panels", () => {
  const dashboard = JSON.parse(
    readFileSync(join(root, "monitoring/grafana/dashboards/outbound-dialer-overview.json"), "utf8")
  );
  const renderer = readFileSync(join(root, "scripts/render-monitoring-config.mjs"), "utf8");

  assert.equal(dashboard.links[0].url, "https://__APP_DOMAIN__/call-history");
  assert.match(renderer, /replaceAll\("__APP_DOMAIN__", appDomain\)/);
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
    "Container restarts (15m)"
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
