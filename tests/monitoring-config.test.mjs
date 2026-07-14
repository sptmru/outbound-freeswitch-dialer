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

test("only Prometheus receives the lifecycle feature flag", () => {
  const compose = readFileSync(join(root, "infra/docker/docker-compose.yml"), "utf8");
  const prometheus = compose.slice(compose.indexOf("  prometheus:"), compose.indexOf("  alertmanager:"));
  const alertmanager = compose.slice(compose.indexOf("  alertmanager:"), compose.indexOf("  grafana:"));

  assert.match(prometheus, /--web\.enable-lifecycle/);
  assert.doesNotMatch(alertmanager, /--web\.enable-lifecycle/);
});
