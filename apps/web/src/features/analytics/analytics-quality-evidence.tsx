import { Activity, Radio, Voicemail } from "lucide-react";
import { PanelHeader } from "../../components/ui-primitives";
import {
  formatBrowserMilliseconds,
  formatDateTime,
  formatMilliseconds,
  formatNullablePercent,
  formatPercent
} from "../../lib/formatters";
import type { AdminAnalyticsResponse } from "../../types";

export function AnalyticsQualityEvidence({ analytics }: { analytics: AdminAnalyticsResponse }) {
  return (
    <section className="analytics-quality-evidence" aria-labelledby="quality-evidence-title">
      <div className="surface-heading">
        <h2 id="quality-evidence-title">Quality evidence</h2>
        <p>Reviewed classifications, observed media telemetry and point-in-time reconciliation.</p>
      </div>
      <div className="analytics-quality-grid">
        <AnalyticsAvmdQuality data={analytics.avmdQuality} />
        <AnalyticsMediaQuality data={analytics.mediaQuality} />
        <AnalyticsTelephonyReliability data={analytics.telephonyReliability} />
      </div>
    </section>
  );
}

function AnalyticsAvmdQuality({ data }: { data: AdminAnalyticsResponse["avmdQuality"] }) {
  return (
    <section className="panel quality-evidence-card avmd-quality-card">
      <PanelHeader icon={Voicemail} meta="reviewed sample" title="AVMD review evidence" />
      <div className="quality-metric-grid">
        <div>
          <span>Review coverage</span>
          <strong>{data.eligibleCalls > 0 ? formatPercent(data.reviewCoverageRate) : "—"}</strong>
          <small>
            {data.reviewedCalls.toLocaleString()} definitive / {data.eligibleCalls.toLocaleString()} eligible
          </small>
        </div>
        <div>
          <span>Uncertain reviews</span>
          <strong>{data.uncertainReviews.toLocaleString()}</strong>
          <small>Excluded from confusion metrics</small>
        </div>
        <div>
          <span>Precision</span>
          <strong>{formatNullablePercent(data.precision)}</strong>
          <small>
            {data.truePositives.toLocaleString()} TP /{" "}
            {(data.truePositives + data.falsePositives).toLocaleString()} detected
          </small>
        </div>
        <div>
          <span>Recall</span>
          <strong>{formatNullablePercent(data.recall)}</strong>
          <small>
            {data.truePositives.toLocaleString()} TP /{" "}
            {(data.truePositives + data.falseNegatives).toLocaleString()} machines
          </small>
        </div>
      </div>
      <div className="confusion-matrix-wrap">
        <table className="confusion-matrix">
          <caption>Detector result compared with definitive reviewer classification</caption>
          <thead>
            <tr>
              <th>Detector</th>
              <th>Machine</th>
              <th>Human</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Detected</th>
              <td>{data.truePositives.toLocaleString()} TP</td>
              <td>{data.falsePositives.toLocaleString()} FP</td>
            </tr>
            <tr>
              <th>Not detected</th>
              <td>{data.falseNegatives.toLocaleString()} FN</td>
              <td>{data.trueNegatives.toLocaleString()} TN</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="quality-inline-stat">
        <span>False-positive rate</span>
        <strong>{formatNullablePercent(data.falsePositiveRate)}</strong>
        <small>
          {data.falsePositives.toLocaleString()} FP /{" "}
          {(data.falsePositives + data.trueNegatives).toLocaleString()} reviewed humans
        </small>
      </div>
      <p className="analytics-note">
        Detected is the positive result; Possible and no signal count as not detected. Rates use only
        definitive reviews, not production-wide truth.
      </p>
    </section>
  );
}

function AnalyticsMediaQuality({ data }: { data: AdminAnalyticsResponse["mediaQuality"] }) {
  const observed = data.observedCalls > 0;
  return (
    <section className="panel quality-evidence-card">
      <PanelHeader icon={Radio} meta="FreeSWITCH counters" title="Media observations" />
      <div className="quality-metric-grid">
        <div>
          <span>Measurement coverage</span>
          <strong>{data.answeredCalls > 0 ? formatPercent(data.coverageRate) : "—"}</strong>
          <small>
            {data.observedCalls.toLocaleString()} observed / {data.answeredCalls.toLocaleString()} technically
            answered
          </small>
        </div>
        <div>
          <span>Suspected one-way</span>
          <strong>{observed ? data.suspectedOneWayCalls.toLocaleString() : "—"}</strong>
          <small>
            {observed ? `of ${data.observedCalls.toLocaleString()} observed calls` : "Not observed"}
          </small>
        </div>
        <div>
          <span>Average MOS</span>
          <strong>{data.averageMos === null ? "—" : data.averageMos.toFixed(2)}</strong>
          <small>FreeSWITCH-reported</small>
        </div>
        <div>
          <span>Average quality</span>
          <strong>{formatNullablePercent(data.averageQualityPercentage)}</strong>
          <small>FreeSWITCH-reported</small>
        </div>
      </div>
      {!observed && data.answeredCalls > 0 && (
        <div className="quality-unavailable">Media telemetry was not observed for answered calls.</div>
      )}
      <div className="media-leg-breakdown">
        {data.legs.map((leg) => (
          <div className="media-leg-summary" key={leg.legType}>
            <div>
              <strong>{leg.legType === "agent" ? "Agent leg" : "Customer leg"}</strong>
              <span>{leg.observedCalls.toLocaleString()} observed calls</span>
            </div>
            <small>
              MOS {leg.averageMos === null ? "—" : leg.averageMos.toFixed(2)} · p95 jitter loss rate{" "}
              {leg.p95JitterLossRate === null
                ? "—"
                : leg.p95JitterLossRate.toLocaleString(undefined, { maximumFractionDigits: 3 })}
            </small>
            <div className="codec-breakdown">
              {leg.codecs.length ? (
                leg.codecs.map((codec) => (
                  <span key={codec.codec}>
                    {codec.codec} <b>{codec.count}</b>
                  </span>
                ))
              ) : (
                <span>Codec not observed</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="provider-breakdown">
        <strong>Provider observations</strong>
        <div className="codec-breakdown">
          {data.providers.length ? (
            data.providers.map((item) => (
              <span key={item.provider}>
                {item.provider} <b>{item.count}</b>
              </span>
            ))
          ) : (
            <span>Provider not observed</span>
          )}
        </div>
      </div>
      <div className="media-leg-breakdown">
        <div className="media-leg-summary">
          <div>
            <strong>Browser playout</strong>
            <span>
              {data.browser.observedCalls.toLocaleString()} observed ·{" "}
              {formatPercent(data.browser.coverageRate)}
            </span>
          </div>
          <small>
            Loss {formatNullablePercent(data.browser.averageInboundLossRate)} · concealed samples{" "}
            {formatNullablePercent(data.browser.averageConcealedSampleRate)} · jitter buffer{" "}
            {data.browser.averageJitterBufferMs === null
              ? "—"
              : `${data.browser.averageJitterBufferMs.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`}
          </small>
          <small>
            p95 jitter {formatBrowserMilliseconds(data.browser.p95JitterMs)} · p95 RTT{" "}
            {formatBrowserMilliseconds(data.browser.p95RoundTripTimeMs)}
          </small>
          <div className="codec-breakdown">
            {data.browser.paths.length ? (
              data.browser.paths.map((path) => (
                <span key={path.path}>
                  {path.path} <b>{path.count}</b>
                </span>
              ))
            ) : (
              <span>Browser path not observed</span>
            )}
          </div>
        </div>
      </div>
      <p className="analytics-note">
        Suspected one-way means captured RTP counters showed media in only one direction. It is a diagnostic
        flag, not confirmation of what either party heard.
      </p>
    </section>
  );
}

function AnalyticsTelephonyReliability({ data }: { data: AdminAnalyticsResponse["telephonyReliability"] }) {
  const registrationAvailable =
    data.registrationDatabaseCount !== null &&
    data.registrationFreeSwitchCount !== null &&
    data.registrationDriftCount !== null;
  const activeCallAvailable =
    data.activeCallsDatabaseCount !== null && data.activeCallsMissingInFreeSwitch !== null;
  return (
    <section className="panel quality-evidence-card">
      <PanelHeader icon={Activity} meta="period + snapshots" title="Telephony reliability" />
      <div className="quality-metric-grid">
        <div>
          <span>Finalization p95</span>
          <strong>{formatMilliseconds(data.p95FinalizationMs)}</strong>
          <small>
            {data.finalizationSamples.toLocaleString()} measured · avg{" "}
            {formatMilliseconds(data.averageFinalizationMs)} · max{" "}
            {formatMilliseconds(data.maxFinalizationMs)}
          </small>
        </div>
        <div>
          <span>Registration count drift</span>
          <strong>
            {registrationAvailable ? data.registrationDriftCount?.toLocaleString() : "Unavailable"}
          </strong>
          <small>
            {registrationAvailable
              ? `DB ${data.registrationDatabaseCount} · FreeSWITCH ${data.registrationFreeSwitchCount}`
              : "No current reconciliation snapshot"}
          </small>
        </div>
        <div>
          <span>DB calls missing in FreeSWITCH</span>
          <strong>
            {activeCallAvailable ? data.activeCallsMissingInFreeSwitch?.toLocaleString() : "Unavailable"}
          </strong>
          <small>
            {activeCallAvailable
              ? `of ${data.activeCallsDatabaseCount} DB-active calls`
              : "No current reconciliation snapshot"}
          </small>
        </div>
        <div>
          <span>Reconciliation closures</span>
          <strong>{data.reconciliationClosures.toLocaleString()}</strong>
          <small>{data.activeCallsClosedLastRun ?? "—"} closed on the latest run</small>
        </div>
      </div>
      <div className="reliability-context">
        <span>
          Registration:{" "}
          {data.registrationReconciledAt ? formatDateTime(data.registrationReconciledAt) : "Unavailable"}
        </span>
        <span>
          Active calls:{" "}
          {data.activeCallsReconciledAt ? formatDateTime(data.activeCallsReconciledAt) : "Unavailable"}
        </span>
      </div>
      <p className="analytics-note">
        Drift is a point-in-time UUID/count reconciliation. Finalization latency is shown only for calls with
        a measured terminal signal.
      </p>
    </section>
  );
}
