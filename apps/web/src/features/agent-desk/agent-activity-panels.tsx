import { AlertTriangle, History, Voicemail } from "lucide-react";

import { PanelHeader, StatusBadge } from "../../components/ui-primitives";
import type { AgentDeskResponse } from "../../types";
import { formatCallLifecycleStatus } from "../../lib/call-formatters";

export function VoicemailJobs({ jobs }: { jobs: AgentDeskResponse["voicemailJobs"] }) {
  if (!jobs.length) {
    return null;
  }
  return (
    <article className="panel background-jobs" aria-live="polite">
      <PanelHeader icon={Voicemail} title="Voicemail jobs" meta={`${jobs.length} recent`} />
      <div className="table-list">
        {jobs.map((job) => (
          <div className="table-row background-job-row" key={job.callId}>
            <span>
              <strong>{job.leadName}</strong>
              <small>{job.phoneNumber}</small>
            </span>
            <StatusBadge
              label={job.status === "playing" ? "Playing" : job.status}
              tone={job.status === "completed" ? "good" : job.status === "interrupted" ? "bad" : "warn"}
            />
          </div>
        ))}
      </div>
    </article>
  );
}

export function RecentAgentCalls({ calls }: { calls: AgentDeskResponse["recentCalls"] }) {
  if (!calls.length) {
    return null;
  }
  return (
    <article className="panel recent-agent-calls">
      <PanelHeader icon={History} title="Recent calls" meta={`${calls.length} calls`} />
      <div className="table-list">
        {calls.map((call) => (
          <div className="table-row recent-call-row" key={call.id}>
            <span>
              <strong>{call.leadName}</strong>
              <small>{call.phoneNumber}</small>
            </span>
            <b className={`outcome-badge outcome-${call.outcome ?? call.state}`}>
              {formatCallLifecycleStatus(call.state, call.outcome)}
            </b>
          </div>
        ))}
      </div>
    </article>
  );
}

export function NoCampaignPanel() {
  return (
    <article className="panel no-campaign-panel">
      <PanelHeader icon={AlertTriangle} title="No active campaign" meta="Setup" />
      <div className="empty-queue-state large-empty-state">
        <strong>No active campaign is available</strong>
        <p>Create or activate a campaign, then import leads.</p>
      </div>
    </article>
  );
}
