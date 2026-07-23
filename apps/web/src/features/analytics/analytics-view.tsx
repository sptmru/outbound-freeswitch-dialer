import { useEffect, useRef, useState } from "react";
import { Activity, BarChart3, CalendarDays, RefreshCw, Shield, Upload, Users, Voicemail } from "lucide-react";
import { fetchAdminAnalytics } from "../../api";
import { PanelHeader, StatusBadge } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import { formatDateTime, formatPercent } from "../../lib/formatters";
import type { AdminAnalyticsResponse, AdminOverviewResponse } from "../../types";
import { AnalyticsQualityEvidence } from "./analytics-quality-evidence";

type AnalyticsDraftFilters = {
  campaignId: string;
  from: string;
  to: string;
};

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function analyticsPreset(days: number): AnalyticsDraftFilters {
  const to = new Date();
  const from = new Date(to);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  return { campaignId: "", from: dateInputValue(from), to: dateInputValue(to) };
}

function analyticsQuery(filters: AnalyticsDraftFilters) {
  let timeZone = "UTC";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // UTC is a safe fallback when an older browser cannot resolve an IANA timezone.
  }
  return {
    campaignId: filters.campaignId || undefined,
    from: new Date(`${filters.from}T00:00:00`).toISOString(),
    to: new Date(`${filters.to}T23:59:59.999`).toISOString(),
    timeZone
  };
}

function formatAnalyticsDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${remainder}s`;
  return `${minutes}m ${remainder}s`;
}

export function AnalyticsView({
  admin,
  refreshVersion
}: {
  admin: AdminOverviewResponse;
  refreshVersion: number;
}) {
  const analyticsCampaignId = new URLSearchParams(window.location.search).get("analyticsCampaignId");
  const initialFilters = useRef({
    ...analyticsPreset(7),
    campaignId:
      analyticsCampaignId && admin.campaigns.some((campaign) => campaign.id === analyticsCampaignId)
        ? analyticsCampaignId
        : ""
  });
  const requestId = useRef(0);
  const [draft, setDraft] = useState<AnalyticsDraftFilters>(initialFilters.current);
  const [analytics, setAnalytics] = useState<AdminAnalyticsResponse | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  async function load(nextFilters: AnalyticsDraftFilters) {
    if (!nextFilters.from || !nextFilters.to || nextFilters.from > nextFilters.to) {
      setError("Choose a valid date range");
      return;
    }
    const currentRequest = ++requestId.current;
    setPending(true);
    setError(null);
    try {
      const next = await fetchAdminAnalytics(analyticsQuery(nextFilters));
      if (currentRequest !== requestId.current) return;
      setAnalytics(next);
      setLastRefreshedAt(new Date().toISOString());
    } catch (loadError) {
      if (currentRequest !== requestId.current) return;
      setError(getErrorMessage(loadError, "Could not load analytics"));
    } finally {
      if (currentRequest === requestId.current) setPending(false);
    }
  }

  useEffect(() => {
    void load(draft);
    return () => {
      requestId.current += 1;
    };
  }, [refreshVersion]);

  function applyPreset(days: number) {
    const next = { ...analyticsPreset(days), campaignId: draft.campaignId };
    setDraft(next);
    void load(next);
  }

  function changeCampaign(campaignId: string) {
    const next = { ...draft, campaignId };
    setDraft(next);
    const url = new URL(window.location.href);
    if (campaignId) {
      url.searchParams.set("analyticsCampaignId", campaignId);
    } else {
      url.searchParams.delete("analyticsCampaignId");
    }
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    void load(next);
  }

  return (
    <div className="analytics-dashboard">
      <section className="panel analytics-filter-panel" aria-label="Analytics filters">
        <div className="analytics-filter-main">
          <div className="analytics-presets" aria-label="Date presets">
            <button className="secondary-action" onClick={() => applyPreset(1)} type="button">
              Today
            </button>
            <button className="secondary-action" onClick={() => applyPreset(7)} type="button">
              7 days
            </button>
            <button className="secondary-action" onClick={() => applyPreset(30)} type="button">
              30 days
            </button>
          </div>
          <div className="analytics-date-fields">
            <label>
              From
              <input
                max={draft.to}
                onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
                type="date"
                value={draft.from}
              />
            </label>
            <label>
              To
              <input
                min={draft.from}
                onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
                type="date"
                value={draft.to}
              />
            </label>
            <label>
              Campaign
              <select onChange={(event) => changeCampaign(event.target.value)} value={draft.campaignId}>
                <option value="">All campaigns</option>
                {admin.campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            className="primary-action analytics-refresh"
            disabled={pending}
            onClick={() => void load(draft)}
            type="button"
          >
            <RefreshCw className={pending ? "spin" : undefined} size={16} />
            {pending ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <div className="analytics-context" aria-live="polite">
          <span>
            <CalendarDays size={14} />
            {analytics
              ? `${new Date(analytics.filters.from).toLocaleDateString()} – ${new Date(
                  analytics.filters.to
                ).toLocaleDateString()}`
              : `${draft.from} – ${draft.to}`}
          </span>
          <span>Source: PostgreSQL call and contact records</span>
          <span>{analytics ? `Dates: ${analytics.filters.timeZone}` : "Dates: local timezone"}</span>
          <span>
            {lastRefreshedAt ? `Last refreshed ${formatDateTime(lastRefreshedAt)}` : "Loading current data"}
          </span>
        </div>
        {error && <p className="form-error">{error}</p>}
      </section>

      {!analytics && pending ? (
        <div className="boot-screen inline" aria-live="polite">
          Loading analytics
        </div>
      ) : analytics ? (
        <>
          <AnalyticsSummaryCards analytics={analytics} />

          <div className="analytics-primary-grid">
            <section className="panel analytics-trend-panel">
              <PanelHeader
                icon={Activity}
                meta={`${analytics.dailyTrend.length} days`}
                title="Daily call trend"
              />
              <AnalyticsTrendChart items={analytics.dailyTrend} />
            </section>
            <section className="panel">
              <PanelHeader icon={BarChart3} meta="selected period" title="Call funnel" />
              <AnalyticsBarList
                items={analytics.funnel.map((item) => ({ label: item.stage, value: item.count }))}
              />
              <p className="analytics-note">
                Connected is an operational proxy that excludes detected or dropped voicemail; it is not
                independently verified human contact.
              </p>
            </section>
          </div>

          <AnalyticsCampaignTable items={analytics.campaignPerformance} />
          <AnalyticsAgentTable items={analytics.agentPerformance} />

          <div className="analytics-secondary-grid">
            <AnalyticsDataQualityPanel data={analytics.dataQuality} />
            <AnalyticsVoicemailPanel data={analytics.voicemail} />
          </div>

          <AnalyticsQualityEvidence analytics={analytics} />
        </>
      ) : (
        <section className="panel empty-row">Analytics are unavailable for this period.</section>
      )}
    </div>
  );
}

function AnalyticsSummaryCards({ analytics }: { analytics: AdminAnalyticsResponse }) {
  const { summary } = analytics;
  const cards = [
    {
      label: "Attempts",
      value: summary.attempts.toLocaleString(),
      detail: `${summary.uniqueContacts.toLocaleString()} unique contacts`
    },
    {
      label: "Answer rate",
      value: formatPercent(summary.answerRate),
      detail: `${summary.answered.toLocaleString()} answered / ${summary.attempts.toLocaleString()} attempts`
    },
    {
      label: "Contact rate",
      value: formatPercent(summary.contactRate),
      detail: `${summary.connected.toLocaleString()} connected calls / ${summary.attempts.toLocaleString()} attempts`
    },
    {
      label: "Average talk time",
      value: formatAnalyticsDuration(summary.averageTalkSeconds),
      detail: "Connected calls"
    },
    { label: "Failed", value: summary.failed.toLocaleString(), detail: "Terminal failed attempts" },
    {
      label: "Voicemail completion",
      value: formatPercent(summary.voicemailCompletionRate),
      detail: `${summary.voicemailCompleted.toLocaleString()} completed drops`
    }
  ];
  return (
    <section className="analytics-kpi-grid" aria-label="Key performance indicators">
      {cards.map((card) => (
        <article className="analytics-kpi-card" key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.detail}</small>
        </article>
      ))}
    </section>
  );
}

function AnalyticsTrendChart({ items }: { items: AdminAnalyticsResponse["dailyTrend"] }) {
  if (items.length < 2) {
    return (
      <div className="analytics-chart-empty">
        Select at least two days to see movement. Period totals remain available above.
      </div>
    );
  }
  const width = 760;
  const height = 230;
  const inset = 24;
  const max = Math.max(1, ...items.flatMap((item) => [item.attempts, item.connected, item.failed]));
  const points = (key: "attempts" | "connected" | "failed") =>
    items
      .map((item, index) => {
        const x = inset + (index * (width - inset * 2)) / (items.length - 1);
        const y = height - inset - (item[key] / max) * (height - inset * 2);
        return `${x},${y}`;
      })
      .join(" ");
  return (
    <div className="analytics-chart-wrap">
      <svg
        aria-label="Daily attempts, connected calls and failures"
        className="analytics-trend-chart"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {[0.25, 0.5, 0.75, 1].map((position) => (
          <line
            className="analytics-grid-line"
            key={position}
            x1={inset}
            x2={width - inset}
            y1={height - inset - position * (height - inset * 2)}
            y2={height - inset - position * (height - inset * 2)}
          />
        ))}
        <polyline className="analytics-line attempts" fill="none" points={points("attempts")} />
        <polyline className="analytics-line connected" fill="none" points={points("connected")} />
        <polyline className="analytics-line failed" fill="none" points={points("failed")} />
      </svg>
      <div className="analytics-chart-axis" aria-hidden="true">
        <span>
          {new Date(`${items[0].date}T00:00:00`).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric"
          })}
        </span>
        <span>
          {new Date(`${items[Math.floor(items.length / 2)].date}T00:00:00`).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric"
          })}
        </span>
        <span>
          {new Date(`${items[items.length - 1].date}T00:00:00`).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric"
          })}
        </span>
      </div>
      <div className="analytics-chart-legend">
        <span>
          <i className="attempts" />
          Attempts
        </span>
        <span>
          <i className="connected" />
          Connected
        </span>
        <span>
          <i className="failed" />
          Failed
        </span>
      </div>
    </div>
  );
}

function AnalyticsBarList({ items }: { items: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <div className="analytics-bar-list">
      {items.map((item) => (
        <div className="analytics-bar-row" key={item.label}>
          <div>
            <span>{item.label}</span>
            <strong>{item.value.toLocaleString()}</strong>
          </div>
          <div className="analytics-bar-track" aria-hidden="true">
            <span style={{ width: item.value === 0 ? "0%" : `${Math.max(2, (item.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function AnalyticsCampaignTable({ items }: { items: AdminAnalyticsResponse["campaignPerformance"] }) {
  return (
    <section className="panel analytics-table-panel">
      <PanelHeader icon={Upload} meta={`${items.length} campaigns`} title="Campaign performance" />
      {items.length ? (
        <div className="analytics-table-scroll">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Base</th>
                <th>Attempts</th>
                <th>Answered</th>
                <th>Contact rate</th>
                <th>Avg talk</th>
                <th>Retry efficiency</th>
                <th>VM complete</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                    <small>{item.status}</small>
                  </td>
                  <td>
                    {item.callable.toLocaleString()} callable
                    <small>{item.loaded.toLocaleString()} loaded</small>
                  </td>
                  <td>
                    {item.attempts.toLocaleString()}
                    <small>{item.attemptedContacts.toLocaleString()} contacts</small>
                  </td>
                  <td>{item.answered.toLocaleString()}</td>
                  <td>
                    <strong>{formatPercent(item.contactRate)}</strong>
                    <small>{item.connected.toLocaleString()} connected</small>
                  </td>
                  <td>{formatAnalyticsDuration(item.averageTalkSeconds)}</td>
                  <td>{formatPercent(item.retryEfficiency)}</td>
                  <td>{item.voicemailCompleted.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-row">No campaign activity in this period.</div>
      )}
    </section>
  );
}

function AnalyticsAgentTable({ items }: { items: AdminAnalyticsResponse["agentPerformance"] }) {
  return (
    <section className="panel analytics-table-panel">
      <PanelHeader icon={Users} meta={`${items.length} agents`} title="Agent performance" />
      {items.length ? (
        <div className="analytics-table-scroll">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Answered</th>
                <th>Contact rate</th>
                <th>Avg talk</th>
                <th>VM drops</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr className={item.isActive ? undefined : "analytics-row-inactive"} key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                    <small>
                      {!item.isActive
                        ? "User inactive"
                        : item.registered
                          ? "Phone registered"
                          : "Phone offline"}
                    </small>
                  </td>
                  <td>
                    <StatusBadge
                      label={
                        !item.isActive
                          ? "Offline"
                          : item.activeCall
                            ? "On call"
                            : item.registered
                              ? "Online"
                              : "Offline"
                      }
                      tone={item.isActive && (item.activeCall || item.registered) ? "good" : "neutral"}
                    />
                  </td>
                  <td>{item.attempts.toLocaleString()}</td>
                  <td>{item.answered.toLocaleString()}</td>
                  <td>
                    <strong>{formatPercent(item.contactRate)}</strong>
                    <small>{item.connected.toLocaleString()} connected</small>
                  </td>
                  <td>{formatAnalyticsDuration(item.averageTalkSeconds)}</td>
                  <td>{item.voicemailDrops.toLocaleString()}</td>
                  <td>{item.failed.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-row">No agent activity in this period.</div>
      )}
    </section>
  );
}

function AnalyticsDataQualityPanel({ data }: { data: AdminAnalyticsResponse["dataQuality"] }) {
  const excluded = data.suppressed + data.exhausted;
  return (
    <section className="panel">
      <PanelHeader icon={Shield} meta="current snapshot" title="Contact data quality" />
      <div className="analytics-mini-grid">
        <div>
          <span>Total contacts</span>
          <strong>{data.totalContacts.toLocaleString()}</strong>
        </div>
        <div>
          <span>Callable now</span>
          <strong>{data.callable.toLocaleString()}</strong>
        </div>
        <div>
          <span>Excluded</span>
          <strong>{excluded.toLocaleString()}</strong>
          <small>
            {data.suppressed} suppressed · {data.exhausted} exhausted
          </small>
        </div>
        <div>
          <span>Imported rows</span>
          <strong>{data.importedRows.toLocaleString()}</strong>
        </div>
      </div>
      <AnalyticsBarList
        items={[
          { label: "Rejected", value: data.rejectedRows },
          { label: "Duplicates", value: data.duplicateRows },
          { label: "Invalid", value: data.invalidRows }
        ]}
      />
      <p className="analytics-note">
        Snapshot {formatDateTime(data.snapshotAt)}. Contact counts are current; import rows cover the selected
        period.
      </p>
    </section>
  );
}

function AnalyticsVoicemailPanel({ data }: { data: AdminAnalyticsResponse["voicemail"] }) {
  return (
    <section className="panel">
      <PanelHeader icon={Voicemail} meta={formatPercent(data.completionRate)} title="Voicemail delivery" />
      <AnalyticsBarList
        items={[
          { label: "Requested", value: data.requested },
          { label: "Playback started", value: data.started },
          { label: "Agent released", value: data.agentReleased },
          { label: "Completed", value: data.completed },
          { label: "Failed / interrupted", value: data.failedOrInterrupted }
        ]}
      />
      <div className="analytics-inline-metric">
        <span>Average agent release</span>
        <strong>{formatAnalyticsDuration(data.averageReleaseSeconds)}</strong>
      </div>
    </section>
  );
}
