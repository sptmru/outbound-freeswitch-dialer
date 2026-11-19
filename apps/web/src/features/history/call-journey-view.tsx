import type { CallDetailResponse } from "../../types";
import { formatDateTime, formatDuration } from "../../lib/formatters";

export function CallJourneyView({ detail }: { detail: CallDetailResponse }) {
  const context = detail.call.context;
  const journey = detail.journey;
  if (!context) return null;
  return (
    <section aria-label="Call journey">
      <h3>Call journey</h3>
      <dl className="call-detail-summary">
        <div>
          <dt>Direction / DID</dt>
          <dd>
            {context.direction} · {context.did ?? "None"}
          </dd>
        </div>
        <div>
          <dt>Queue</dt>
          <dd>{context.queueName ?? "None"}</dd>
        </div>
        <div>
          <dt>Queue wait</dt>
          <dd>{context.queueWaitMs === null ? "Unknown" : formatDuration(context.queueWaitMs / 1000)}</dd>
        </div>
        <div>
          <dt>Queue exit</dt>
          <dd>{context.queueExit ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Flow outcome</dt>
          <dd>{context.flowOutcome ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Terminal reason</dt>
          <dd>{context.terminalReason ?? detail.call.hangupCause ?? "Not recorded"}</dd>
        </div>
        {context.manualCorrectionAt && (
          <div>
            <dt>Manual outcome correction</dt>
            <dd>{formatDateTime(context.manualCorrectionAt)}</dd>
          </div>
        )}
      </dl>
      {journey && (
        <>
          <h4>Participants</h4>
          <table>
            <thead>
              <tr>
                <th>Participant</th>
                <th>Connected</th>
                <th>Left</th>
                <th>Talk time</th>
                <th>Media evidence</th>
              </tr>
            </thead>
            <tbody>
              {journey.participants.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.agentName ?? p.externalNumber ?? p.role} ({p.role})
                  </td>
                  <td>{p.connectedAt ? formatDateTime(p.connectedAt) : "Not connected"}</td>
                  <td>{p.leftAt ? formatDateTime(p.leftAt) : "Not recorded"}</td>
                  <td>{p.connectedMs === null ? "Unknown" : formatDuration(p.connectedMs / 1000)}</td>
                  <td>
                    {p.media
                      ? `RTP ${p.media.inboundPackets ?? "?"} / ${p.media.outboundPackets ?? "?"}`
                      : "No RTP summary"}
                    {p.browserMedia ? ` · ${p.browserMedia.sampleCount} browser samples` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Agent offers</h4>
          <p>
            Ignore, expiry and manual dismissal describe an agent offer; the customer result is shown
            separately.
          </p>
          <ul>
            {journey.offers.items.map((o) => (
              <li key={o.id}>
                {o.agentName} · {o.kind} · {o.state} · {o.reason ?? "pending"}
              </li>
            ))}
          </ul>
          <h4>Transfer attempts</h4>
          <ul>
            {journey.transfers.items.map((t) => (
              <li key={t.id}>
                {t.sourceName} → {t.recipientName} · {t.state} · {t.reason ?? "pending"}
              </li>
            ))}
          </ul>
          <h4>Flow steps</h4>
          <ul>
            {journey.steps.items.map((s) => (
              <li key={s.id}>
                Step {s.step ?? "?"} · {s.action} · {s.state} · {s.outcome ?? "unresolved"}
                {s.reason ? ` · ${s.reason}` : ""}
              </li>
            ))}
          </ul>
          {Object.entries(journey)
            .filter(([, p]) => p.truncated)
            .map(([name, p]) => (
              <p role="status" key={name}>
                Showing first {p.items.length} of {p.total} {name}.
              </p>
            ))}
        </>
      )}
    </section>
  );
}
