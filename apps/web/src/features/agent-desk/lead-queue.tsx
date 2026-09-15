import { useState } from "react";
import { CheckCircle2, Clock3, ExternalLink, PhoneCall, Search } from "lucide-react";

import { getDisplayCompany } from "../../lib/lead-formatters";
import type { LeadSummary } from "../../types";
import { formatCallLifecycleStatus } from "../../lib/call-formatters";

export function LeadQueue({
  canStartCalls,
  error,
  leads,
  onCallLead,
  onCallNext,
  pending,
  showRecommendedCall = true
}: {
  canStartCalls: boolean;
  error: string | null;
  leads: LeadSummary[];
  onCallLead: (lead: LeadSummary) => Promise<void>;
  onCallNext: () => Promise<void>;
  pending: boolean;
  showRecommendedCall?: boolean;
}) {
  const [query, setQuery] = useState("");
  const recommended = leads.find((lead) => lead.status === "ready");
  const visibleLeads = leads.filter((lead) =>
    `${lead.name} ${getDisplayCompany(lead.company)} ${lead.phoneNumber}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  );
  const activeQueue = !showRecommendedCall;

  return (
    <article className="panel lead-queue next-leads-panel">
      <div className="surface-heading">
        <div className="heading-with-count">
          <h2>{activeQueue ? "Lead queue" : "Next leads"}</h2>
          <span>{leads.length}</span>
        </div>
        <p>{activeQueue ? "Current campaign queue" : "Start the next call from the campaign queue."}</p>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {showRecommendedCall && recommended && (
        <div className="recommended-call">
          <h3>Next lead</h3>
          <p>
            {recommended.name}, {recommended.phoneNumber}
          </p>
          <button
            className="primary-action teal-action"
            disabled={pending || !canStartCalls}
            onClick={onCallNext}
            type="button"
          >
            <PhoneCall size={17} />
            {pending ? "Starting" : "Start next call"}
          </button>
        </div>
      )}
      {showRecommendedCall && !recommended && (
        <p className="empty-state">
          No contacts are callable yet. Retries become available after the configured cooldown.
        </p>
      )}
      <label className="queue-search">
        <Search size={15} />
        <input
          aria-label="Search leads"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name or phone"
          value={query}
        />
      </label>
      <div className="lead-table" role="table" aria-label={activeQueue ? "Lead queue" : "Next leads"}>
        <div className="lead-table-row lead-table-head" role="row">
          <span aria-hidden="true" />
          <span role="columnheader">Lead</span>
          <span role="columnheader">Status</span>
        </div>
        {visibleLeads.map((lead) => {
          const company = getDisplayCompany(lead.company);
          const zohoLeadId = lead.zohoLeadId?.trim();
          return (
            <div className={`lead-table-row lead-${lead.status}`} key={lead.id} role="row">
              <span className="lead-avatar" aria-hidden="true">
                {getInitials(lead.name)}
              </span>
              <div className="lead-identity" role="cell">
                <strong>{lead.name}</strong>
                {activeQueue && company && <small>{company}</small>}
                <span>{lead.phoneNumber}</span>
                {zohoLeadId && (
                  <a
                    className="lead-crm-link"
                    href={`https://crm.zoho.com.au/crm/org7002688441/tab/Leads/${encodeURIComponent(zohoLeadId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${lead.name} in Zoho CRM (opens in a new tab)`}
                  >
                    Zoho CRM <ExternalLink size={12} aria-hidden="true" />
                  </a>
                )}
              </div>
              <div className="lead-row-state" role="cell">
                <b>{formatLeadStatus(lead)}</b>
                {showRecommendedCall && (
                  <button
                    className="pill-action"
                    disabled={
                      pending || !["ready", "retry_wait", "completed"].includes(lead.status) || !canStartCalls
                    }
                    onClick={() => onCallLead(lead)}
                    type="button"
                  >
                    Call
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!visibleLeads.length && (
          <div className="lead-table-empty" role="row">
            <span role="cell">
              {leads.length ? "No leads match your search." : "No leads are queued for this campaign."}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

function getInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

export function LeadContextPanel({ lead }: { lead?: LeadSummary }) {
  const company = getDisplayCompany(lead?.company);
  const visibleFields =
    lead?.fields
      .filter(({ label }) => !["company", "name", "phone"].includes(label.toLowerCase()))
      .slice(0, 5) ?? [];

  return (
    <article className="panel lead-context-panel">
      <div className="surface-heading">
        <h2>Lead context</h2>
        <p>Visible throughout the call</p>
      </div>
      {company && (
        <div className="company-card">
          <span>Company</span>
          <strong>{company}</strong>
          <small>Campaign lead</small>
        </div>
      )}
      <div className="lead-facts">
        {visibleFields.map((field) => (
          <div key={field.label}>
            <span>{field.label}</span>
            <strong>{field.value}</strong>
          </div>
        ))}
        {!visibleFields.length && (
          <div>
            <span>Phone</span>
            <strong>{lead?.phoneNumber ?? "Not available"}</strong>
          </div>
        )}
      </div>
      <div className="compliance-card">
        {lead?.status === "ready" ? <CheckCircle2 size={15} /> : <Clock3 size={15} />}
        <span>{lead ? leadAvailabilityCopy(lead.status) : "Select a lead"}</span>
      </div>
    </article>
  );
}

function formatLeadStatus(lead: LeadSummary): string {
  const labels: Record<LeadSummary["status"], string> = {
    calling: "Connected",
    completed: "Completed",
    exhausted: "Attempt limit reached",
    ready: "Ready",
    retry_wait: lead.lastCallState
      ? formatCallLifecycleStatus(lead.lastCallState, lead.lastCallOutcome ?? null)
      : "No answer",
    suppressed: "Suppressed"
  };
  return labels[lead.status];
}

function leadAvailabilityCopy(status: LeadSummary["status"]): string {
  if (status === "ready") return "Callable · suppression check passed";
  if (status === "retry_wait") return "Retry cooldown is active";
  if (status === "exhausted") return "Configured attempt limit reached";
  if (status === "suppressed") return "Calling blocked by suppression";
  if (status === "completed") return "Contact lifecycle completed";
  return "Call in progress";
}
