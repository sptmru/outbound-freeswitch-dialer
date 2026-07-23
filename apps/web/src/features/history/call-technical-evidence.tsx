import { StatusBadge } from "../../components/ui-primitives";
import {
  formatBrowserMilliseconds,
  formatDateTime,
  formatMilliseconds,
  formatNullablePercent,
  formatPercent
} from "../../lib/formatters";
import type { BrowserMediaTelemetry, CallDetailResponse, CallMediaQuality } from "../../types";

function formatMediaValue(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function MediaQualityCard({ item }: { item: CallMediaQuality }) {
  return (
    <div className="call-media-quality-card">
      <div>
        <strong>{item.legType === "agent" ? "Agent leg" : "Customer leg"}</strong>
        {item.suspectedOneWayAudio && <StatusBadge label="Suspected one-way" tone="warn" />}
      </div>
      <dl>
        <div>
          <dt>Read codec</dt>
          <dd>{item.readCodec ?? "—"}</dd>
        </div>
        <div>
          <dt>Write codec</dt>
          <dd>{item.writeCodec ?? "—"}</dd>
        </div>
        {item.sipGateway && (
          <div>
            <dt>SIP gateway</dt>
            <dd>{item.sipGateway}</dd>
          </div>
        )}
        {item.sipProfile && (
          <div>
            <dt>SIP profile</dt>
            <dd>{item.sipProfile}</dd>
          </div>
        )}
        <div>
          <dt>Inbound media packets</dt>
          <dd>{formatMediaValue(item.inboundMediaPacketCount)}</dd>
        </div>
        <div>
          <dt>Outbound media packets</dt>
          <dd>{formatMediaValue(item.outboundMediaPacketCount)}</dd>
        </div>
        <div>
          <dt>MOS</dt>
          <dd>{formatMediaValue(item.inboundMos)}</dd>
        </div>
        <div>
          <dt>Quality</dt>
          <dd>
            {item.inboundQualityPercentage === null ? "—" : formatPercent(item.inboundQualityPercentage)}
          </dd>
        </div>
      </dl>
      <small>Captured {formatDateTime(item.capturedAt)}</small>
    </div>
  );
}

function browserRate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function BrowserMediaQualityCard({ item }: { item: BrowserMediaTelemetry }) {
  const lossRate = browserRate(
    item.inbound.packetsLost,
    item.inbound.packetsReceived === null || item.inbound.packetsLost === null
      ? null
      : item.inbound.packetsReceived + item.inbound.packetsLost
  );
  const concealedRate = browserRate(item.inbound.concealedSamples, item.inbound.totalSamplesReceived);
  const jitterBufferMs =
    item.inbound.jitterBufferDelaySeconds !== null &&
    item.inbound.jitterBufferEmittedCount !== null &&
    item.inbound.jitterBufferEmittedCount > 0
      ? (item.inbound.jitterBufferDelaySeconds / item.inbound.jitterBufferEmittedCount) * 1000
      : null;
  return (
    <div className="call-media-quality-card">
      <div>
        <strong>Browser WebRTC</strong>
        <StatusBadge label={`${item.sampleCount} samples`} tone="neutral" />
      </div>
      <dl>
        <div>
          <dt>Inbound / outbound codec</dt>
          <dd>
            {item.inbound.codec ?? "—"} / {item.outbound.codec ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Packet loss</dt>
          <dd>{formatNullablePercent(lossRate)}</dd>
        </div>
        <div>
          <dt>Concealed samples</dt>
          <dd>{formatNullablePercent(concealedRate)}</dd>
        </div>
        <div>
          <dt>Maximum jitter</dt>
          <dd>
            {formatBrowserMilliseconds(
              item.inbound.jitterSecondsMax === null ? null : item.inbound.jitterSecondsMax * 1000
            )}
          </dd>
        </div>
        <div>
          <dt>Average jitter buffer</dt>
          <dd>{formatBrowserMilliseconds(jitterBufferMs)}</dd>
        </div>
        <div>
          <dt>Maximum RTT</dt>
          <dd>
            {formatBrowserMilliseconds(
              item.outbound.roundTripTimeSecondsMax === null
                ? null
                : item.outbound.roundTripTimeSecondsMax * 1000
            )}
          </dd>
        </div>
        <div>
          <dt>ICE path</dt>
          <dd>
            {item.connection.localCandidateType ?? "—"} → {item.connection.remoteCandidateType ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Microphone DSP</dt>
          <dd>
            AEC{" "}
            {item.microphone.echoCancellation === null
              ? "—"
              : item.microphone.echoCancellation
                ? "on"
                : "off"}{" "}
            · NS{" "}
            {item.microphone.noiseSuppression === null
              ? "—"
              : item.microphone.noiseSuppression
                ? "on"
                : "off"}{" "}
            · AGC{" "}
            {item.microphone.autoGainControl === null ? "—" : item.microphone.autoGainControl ? "on" : "off"}
          </dd>
        </div>
        <div>
          <dt>Capture format</dt>
          <dd>
            {item.microphone.sampleRate?.toLocaleString() ?? "—"} Hz · {item.microphone.channelCount ?? "—"}{" "}
            ch
          </dd>
        </div>
      </dl>
      <small>Captured {formatDateTime(item.capturedAt)}</small>
    </div>
  );
}

export function CallTechnicalEvidence({ detail }: { detail: CallDetailResponse }) {
  const terminalMeasured = detail.call.finalizationLatencyMs !== null;
  return (
    <div className="call-technical-evidence">
      <section>
        <h4>Terminal persistence</h4>
        <div className="technical-evidence-grid">
          <div>
            <span>Source</span>
            <strong>{detail.call.terminalSource ?? "Not measured"}</strong>
          </div>
          <div>
            <span>Event</span>
            <strong>{detail.call.terminalEventName ?? "—"}</strong>
          </div>
          <div>
            <span>FreeSWITCH terminal</span>
            <strong>
              {detail.call.freeswitchTerminalAt ? formatDateTime(detail.call.freeswitchTerminalAt) : "—"}
            </strong>
          </div>
          <div>
            <span>Persisted terminal</span>
            <strong>
              {detail.call.terminalPersistedAt ? formatDateTime(detail.call.terminalPersistedAt) : "—"}
            </strong>
          </div>
          <div>
            <span>Finalization lag</span>
            <strong>
              {terminalMeasured ? formatMilliseconds(detail.call.finalizationLatencyMs) : "Not measured"}
            </strong>
          </div>
        </div>
      </section>
      <section>
        <h4>Media observations</h4>
        <p>FreeSWITCH counters and browser playout evidence are shown separately.</p>
        {detail.mediaQuality.length ? (
          <div className="call-media-quality-grid">
            {detail.mediaQuality.map((item) => (
              <MediaQualityCard item={item} key={item.legType} />
            ))}
          </div>
        ) : (
          <div className="quality-unavailable">No FreeSWITCH media telemetry was captured.</div>
        )}
        {detail.browserMedia ? (
          <div className="call-media-quality-grid">
            <BrowserMediaQualityCard item={detail.browserMedia} />
          </div>
        ) : (
          <div className="quality-unavailable">No browser WebRTC telemetry was captured.</div>
        )}
      </section>
    </div>
  );
}
