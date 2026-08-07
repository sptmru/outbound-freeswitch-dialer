import { useEffect, useRef, useState } from "react";
import { Activity, Download, History } from "lucide-react";
import { downloadCallHistoryCsv, downloadCallPcap, fetchCallDetail, fetchCallHistory } from "../../api";
import { PanelHeader } from "../../components/ui-primitives";
import { formatCallLifecycleStatus } from "../../lib/call-formatters";
import { getErrorMessage } from "../../lib/errors";
import { formatBytes, formatDateTime, formatDuration } from "../../lib/formatters";
import type {
  AdminOverviewResponse,
  CallDetailResponse,
  CallEndRequestAudit,
  CallHistoryResponse
} from "../../types";
import { AvmdReviewCard } from "./avmd-review-card";
import { CallRecordingPlayer } from "./call-recording-player";
import { CallTechnicalEvidence } from "./call-technical-evidence";
import {
  formatAvmdReviewStatus,
  formatOutcomeFilterOption,
  formatPcapStatus,
  formatRecordingStatus,
  historyDateBoundary
} from "./history-formatters";

export function HistoryView({
  admin,
  refreshVersion
}: {
  admin: AdminOverviewResponse;
  refreshVersion: number;
}) {
  const detailRequestRef = useRef(0);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [technicalCallId, setTechnicalCallId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CallDetailResponse | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<CallHistoryResponse>({
    items: admin.callHistory,
    page: 1,
    pageSize: 25,
    total: admin.callHistory.length,
    totalPages: admin.callHistory.length ? 1 : 0
  });
  const [query, setQuery] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [outcome, setOutcome] = useState("");
  const [recording, setRecording] = useState<"" | "available" | "missing">("");
  const [agentId, setAgentId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [voicemail, setVoicemail] = useState<"" | "drop" | "signal">("");
  const [avmdReview, setAvmdReview] = useState<"" | "needs_review" | "reviewed" | "uncertain">("");
  const [page, setPage] = useState(1);
  const [historyPending, setHistoryPending] = useState(false);
  const [pcapPendingId, setPcapPendingId] = useState<string | null>(null);

  useEffect(
    () => () => {
      detailRequestRef.current += 1;
    },
    []
  );

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setHistoryPending(true);
      void fetchCallHistory({
        page,
        pageSize: 25,
        q: query || undefined,
        campaignId: campaignId || undefined,
        agentId: agentId || undefined,
        outcome: outcome || undefined,
        from: historyDateBoundary(dateFrom, false),
        to: historyDateBoundary(dateTo, true),
        voicemail: voicemail || undefined,
        recording: recording || undefined,
        avmdReview: avmdReview || undefined
      })
        .then((next) => {
          if (active) setHistory(next);
        })
        .catch((loadError) => {
          if (active) setError(getErrorMessage(loadError, "Could not load call history"));
        })
        .finally(() => {
          if (active) setHistoryPending(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [
    agentId,
    avmdReview,
    campaignId,
    dateFrom,
    dateTo,
    outcome,
    page,
    query,
    recording,
    refreshVersion,
    voicemail
  ]);

  async function exportHistory() {
    setError(null);
    try {
      const blob = await downloadCallHistoryCsv({
        q: query || undefined,
        campaignId: campaignId || undefined,
        agentId: agentId || undefined,
        outcome: outcome || undefined,
        from: historyDateBoundary(dateFrom, false),
        to: historyDateBoundary(dateTo, true),
        voicemail: voicemail || undefined,
        recording: recording || undefined,
        avmdReview: avmdReview || undefined
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `call-history-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(getErrorMessage(exportError, "Could not export call history"));
    }
  }

  async function toggleCall(callId: string) {
    if (selectedCallId === callId) {
      detailRequestRef.current += 1;
      setSelectedCallId(null);
      setTechnicalCallId(null);
      setDetail(null);
      return;
    }
    setSelectedCallId(callId);
    setTechnicalCallId(null);
    setDetail(null);
    setPendingId(callId);
    setError(null);
    const requestId = ++detailRequestRef.current;
    try {
      const nextDetail = await fetchCallDetail(callId);
      if (requestId !== detailRequestRef.current) return;
      setDetail(nextDetail);
    } catch (detailError) {
      if (requestId !== detailRequestRef.current) return;
      setError(getErrorMessage(detailError, "Could not load call details"));
    } finally {
      if (requestId === detailRequestRef.current) setPendingId(null);
    }
  }

  async function downloadPcap(callId: string) {
    setPcapPendingId(callId);
    setError(null);
    try {
      const blob = await downloadCallPcap(callId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${callId}.pcap`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(getErrorMessage(downloadError, "Could not download PCAP capture"));
    } finally {
      setPcapPendingId(null);
    }
  }

  return (
    <article className="panel wide-panel">
      <PanelHeader
        icon={History}
        title="Call history"
        meta={historyPending ? "loading" : `${history.total} calls`}
      />
      <div className="history-filters">
        <label>
          Search
          <input
            aria-label="Search call history"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Lead, phone, campaign or agent"
          />
        </label>
        <label>
          Campaign
          <select
            value={campaignId}
            onChange={(event) => {
              setCampaignId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All campaigns</option>
            {admin.campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent
          <select
            value={agentId}
            onChange={(event) => {
              setAgentId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All agents</option>
            {admin.users
              .filter((user) => user.role === "agent")
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Outcome
          <select
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All outcomes</option>
            {[
              "answered",
              "not_answered",
              "busy",
              "failed",
              "voicemail_detected",
              "voicemail_dropped",
              "agent_canceled",
              "customer_hung_up",
              "suppressed"
            ].map((item) => (
              <option key={item} value={item}>
                {formatOutcomeFilterOption(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            aria-label="History from date"
            type="date"
            value={dateFrom}
            onChange={(event) => {
              setDateFrom(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          To
          <input
            aria-label="History to date"
            type="date"
            value={dateTo}
            onChange={(event) => {
              setDateTo(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          Voicemail
          <select
            value={voicemail}
            onChange={(event) => {
              setVoicemail(event.target.value as typeof voicemail);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="drop">Drop requested</option>
            <option value="signal">Signal detected</option>
          </select>
        </label>
        <label>
          Recording
          <select
            value={recording}
            onChange={(event) => {
              setRecording(event.target.value as typeof recording);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="available">Available</option>
            <option value="missing">Missing</option>
          </select>
        </label>
        <label>
          AVMD review
          <select
            aria-label="AVMD review"
            value={avmdReview}
            onChange={(event) => {
              setAvmdReview(event.target.value as typeof avmdReview);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="needs_review">Needs review</option>
            <option value="reviewed">Reviewed</option>
            <option value="uncertain">Uncertain</option>
          </select>
        </label>
        <button
          className="secondary-action compact-action"
          onClick={() => void exportHistory()}
          type="button"
        >
          Export CSV
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="history-head" aria-hidden="true">
        <span>Lead</span>
        <span>Campaign</span>
        <span>Agent</span>
        <span>Started</span>
        <span>Status</span>
      </div>
      <div className="table-list">
        {history.items.map((call) => (
          <div className="history-entry" key={call.id}>
            <button
              aria-expanded={selectedCallId === call.id}
              className="table-row history-row clickable-row"
              onClick={() => void toggleCall(call.id)}
              type="button"
            >
              <span className="history-lead">
                <strong>{call.leadName}</strong>
                <small>{call.phoneNumber}</small>
              </span>
              <span>{call.campaignName}</span>
              <span>{call.agentName}</span>
              <span>
                {formatDateTime(call.createdAt)}
                <small>{formatDuration(call.durationSeconds)}</small>
              </span>
              <span className="history-outcome-stack">
                <b className={`outcome-badge outcome-${call.outcome ?? call.state}`}>
                  {formatCallLifecycleStatus(call.state, call.outcome)}
                </b>
                {call.avmdReviewStatus && (
                  <small className={`avmd-review-badge ${call.avmdReviewStatus}`}>
                    {formatAvmdReviewStatus(call.avmdReviewStatus)}
                  </small>
                )}
              </span>
            </button>
            {selectedCallId === call.id && (
              <div className="call-detail">
                {pendingId === call.id && <p>Loading call details…</p>}
                {detail?.call.id === call.id && (
                  <>
                    <div className="call-detail-summary">
                      <span>
                        <strong>Type</strong>
                        {detail.call.manualDial ? "Manual dial" : "Campaign lead"}
                      </span>
                      <span>
                        <strong>Answered</strong>
                        {detail.call.answeredAt ? formatDateTime(detail.call.answeredAt) : "Not answered"}
                      </span>
                      <span>
                        <strong>Ended</strong>
                        {detail.call.endedAt ? formatDateTime(detail.call.endedAt) : "In progress"}
                      </span>
                      <span>
                        <strong>Recording</strong>
                        {formatRecordingStatus(detail.call.recordingStatus)}
                      </span>
                      <span>
                        <strong>Packet capture</strong>
                        {detail.call.pcapStatus ? formatPcapStatus(detail.call.pcapStatus) : "Not captured"}
                      </span>
                      {detail.call.pcapFileSizeBytes !== null && (
                        <span>
                          <strong>PCAP size</strong>
                          {formatBytes(detail.call.pcapFileSizeBytes)}
                        </span>
                      )}
                      {detail.call.pcapFailureReason && (
                        <span>
                          <strong>PCAP issue</strong>
                          {detail.call.pcapFailureReason}
                        </span>
                      )}
                      {detail.call.recordingDurationSeconds !== null && (
                        <span>
                          <strong>Recording length</strong>
                          {formatDuration(detail.call.recordingDurationSeconds)}
                        </span>
                      )}
                      {detail.call.recordingFileSizeBytes !== null && (
                        <span>
                          <strong>Recording size</strong>
                          {formatBytes(detail.call.recordingFileSizeBytes)}
                        </span>
                      )}
                      {detail.call.recordingIntegrityCheckedAt && (
                        <span>
                          <strong>Integrity checked</strong>
                          {formatDateTime(detail.call.recordingIntegrityCheckedAt)}
                        </span>
                      )}
                      {detail.call.recordingFailureReason && (
                        <span>
                          <strong>Recording issue</strong>
                          {detail.call.recordingFailureReason}
                        </span>
                      )}
                      <span>
                        <strong>VM signal</strong>
                        {detail.call.voicemailSignal ?? "None"}
                        {detail.call.voicemailConfidence !== null
                          ? ` (${detail.call.voicemailConfidence})`
                          : ""}
                      </span>
                      <span>
                        <strong>Hangup</strong>
                        {detail.call.hangupCause ?? detail.call.lastReasonCode ?? "Not reported"}
                      </span>
                    </div>
                    {detail.call.recordingAvailable && (
                      <CallRecordingPlayer callId={detail.call.id} leadName={detail.call.leadName} />
                    )}
                    <AvmdReviewCard
                      detail={detail}
                      key={detail.call.id}
                      onSaved={(review) => {
                        setDetail((current) => (current ? { ...current, avmdReview: review } : current));
                        setHistory((current) => ({
                          ...current,
                          items: current.items.map((item) =>
                            item.id === call.id
                              ? {
                                  ...item,
                                  avmdReviewStatus:
                                    review.actualParty === "uncertain" ? "uncertain" : "reviewed"
                                }
                              : item
                          )
                        }));
                      }}
                    />
                    {detail.call.pcapAvailable && (
                      <div className="pcap-download-card">
                        <div>
                          <strong>Packet capture</strong>
                          <small>Filtered to this call's SIP signaling and media ports.</small>
                        </div>
                        <button
                          className="secondary-action compact-action"
                          disabled={pcapPendingId === call.id}
                          onClick={() => void downloadPcap(call.id)}
                          type="button"
                        >
                          <Download size={15} />
                          {pcapPendingId === call.id ? "Preparing" : "Download PCAP"}
                        </button>
                      </div>
                    )}
                    <div className="technical-details">
                      <button
                        aria-expanded={technicalCallId === call.id}
                        className="secondary-action compact-action technical-toggle"
                        onClick={() => setTechnicalCallId(technicalCallId === call.id ? null : call.id)}
                        type="button"
                      >
                        <Activity size={14} />
                        {technicalCallId === call.id ? "Hide technical details" : "Show technical details"}
                      </button>
                      {technicalCallId === call.id && (
                        <div className="technical-call-details">
                          <CallTechnicalEvidence detail={detail} />
                          <div className="call-leg-grid">
                            {detail.legs?.map((leg) => (
                              <div className="call-leg-card" key={leg.type}>
                                <strong>{leg.type === "agent" ? "Agent leg" : "Customer leg"}</strong>
                                <span>{leg.state}</span>
                                <code>{leg.freeswitchUuid ?? "UUID not assigned"}</code>
                                {leg.sipUri && <small>{leg.sipUri}</small>}
                                {(leg.hangupCause || leg.reasonCode) && (
                                  <small>
                                    {[leg.hangupCause, leg.reasonCode].filter(Boolean).join(" · ")}
                                  </small>
                                )}
                              </div>
                            ))}
                          </div>
                          <div className="history-timeline">
                            {detail.timelineTruncated && (
                              <p className="analytics-note">
                                Showing the latest {detail.timeline.length} of {detail.timelineTotal} recorded
                                events.
                              </p>
                            )}
                            {detail.timeline.map((item, index) => (
                              <div className="timeline-item" key={`${item.at}-${item.eventType}-${index}`}>
                                <span>{formatDateTime(item.at)}</span>
                                <p>{item.label}</p>
                                {(item.reasonCode || item.freeSwitchEventName || item.apiCommandName) && (
                                  <small>
                                    {[item.freeSwitchEventName, item.apiCommandName, item.reasonCode]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </small>
                                )}
                                {(item.agentLegUuid || item.customerLegUuid) && (
                                  <code>
                                    {[
                                      item.agentLegUuid && `agent ${item.agentLegUuid}`,
                                      item.customerLegUuid && `customer ${item.customerLegUuid}`
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </code>
                                )}
                                {item.callEndRequest && (
                                  <CallEndRequestEvidence audit={item.callEndRequest} />
                                )}
                              </div>
                            ))}
                            {!detail.timeline.length && (
                              <p className="empty-state">No call events recorded.</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {!history.items.length && <div className="empty-row">No calls match these filters</div>}
      </div>
      <div className="pagination-controls">
        <button
          className="secondary-action compact-action"
          disabled={history.page <= 1 || historyPending}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          type="button"
        >
          Previous
        </button>
        <span>
          Page {history.page} of {Math.max(history.totalPages, 1)}
        </span>
        <button
          className="secondary-action compact-action"
          disabled={history.page >= history.totalPages || historyPending}
          onClick={() => setPage((current) => current + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </article>
  );
}

function CallEndRequestEvidence({ audit }: { audit: CallEndRequestAudit }) {
  const client = audit.clientContext;
  const isAgentDeskButton = client?.initiator === "agent_desk_hangup_button";
  const clickEvidence = isAgentDeskButton
    ? client.browserEventTrusted
      ? "Browser marked the Hang up click as trusted"
      : "Browser did not mark the Hang up event as trusted"
    : "No first-party Agent Desk click context was supplied";

  return (
    <div className="timeline-end-request">
      <strong>{isAgentDeskButton ? "Agent Desk Hang up request" : "API or legacy Hang up request"}</strong>
      <small>{clickEvidence}</small>
      <dl>
        <div>
          <dt>Actor</dt>
          <dd>
            {audit.actorName} · {audit.actorRole}
          </dd>
        </div>
        <div>
          <dt>Previous call state</dt>
          <dd>{audit.previousCallState}</dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>
            {audit.requestId} · {audit.authTransport}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{[audit.sourceIp, audit.userAgent].filter(Boolean).join(" · ") || "Not recorded"}</dd>
        </div>
        {client && (
          <>
            <div>
              <dt>Client state</dt>
              <dd>
                call {client.activeCallStatus} · softphone {client.softphoneCallState} · tab{" "}
                {client.visibilityState}
              </dd>
            </div>
            <div>
              <dt>Client time and page</dt>
              <dd>
                {formatDateTime(client.clientTimestamp)} · {client.pagePath}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>Browser request</dt>
          <dd>
            {[audit.origin, audit.referrer, audit.secFetchSite, audit.secFetchMode, audit.secFetchDest]
              .filter(Boolean)
              .join(" · ") || "No browser fetch headers recorded"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export { formatCallLifecycleStatus } from "../../lib/call-formatters";
export { historyDateBoundary } from "./history-formatters";
