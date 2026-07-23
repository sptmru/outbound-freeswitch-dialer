import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  CheckCircle2,
  History,
  Pencil,
  PhoneCall,
  RefreshCw,
  Trash2,
  Upload,
  Users,
  XCircle
} from "lucide-react";
import { resetCampaignLeads, updateCampaign } from "../../api";
import { Metric, StatusBadge } from "../../components/ui-primitives";
import type { AdminOverviewResponse } from "../../types";

export function CampaignCard({
  campaign,
  onChanged
}: {
  campaign: AdminOverviewResponse["campaigns"][number];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [status, setStatus] = useState(campaign.status);
  const [manualDialingEnabled, setManualDialingEnabled] = useState(campaign.manualDialingEnabled);
  const [callRecordingEnabled, setCallRecordingEnabled] = useState(campaign.callRecordingEnabled);
  const [earlyMediaAvmdEnabled, setEarlyMediaAvmdEnabled] = useState(campaign.earlyMediaAvmdEnabled);
  const [autoAdvanceToNextLeadEnabled, setAutoAdvanceToNextLeadEnabled] = useState(
    campaign.autoAdvanceToNextLeadEnabled
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  useEffect(() => {
    setName(campaign.name);
    setStatus(campaign.status);
    setManualDialingEnabled(campaign.manualDialingEnabled);
    setCallRecordingEnabled(campaign.callRecordingEnabled);
    setEarlyMediaAvmdEnabled(campaign.earlyMediaAvmdEnabled);
    setAutoAdvanceToNextLeadEnabled(campaign.autoAdvanceToNextLeadEnabled);
  }, [
    campaign.autoAdvanceToNextLeadEnabled,
    campaign.callRecordingEnabled,
    campaign.earlyMediaAvmdEnabled,
    campaign.manualDialingEnabled,
    campaign.name,
    campaign.status
  ]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await updateCampaign(campaign.id, {
        name,
        status,
        manualDialingEnabled,
        callRecordingEnabled,
        earlyMediaAvmdEnabled,
        autoAdvanceToNextLeadEnabled
      });
      setEditing(false);
      await onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not update campaign");
    } finally {
      setPending(false);
    }
  }

  async function archive() {
    if (!window.confirm(`Archive campaign "${campaign.name}"? Historical calls will remain available.`)) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await updateCampaign(campaign.id, {
        name: campaign.name,
        status: "archived",
        manualDialingEnabled: campaign.manualDialingEnabled,
        callRecordingEnabled: campaign.callRecordingEnabled,
        earlyMediaAvmdEnabled: campaign.earlyMediaAvmdEnabled,
        autoAdvanceToNextLeadEnabled: campaign.autoAdvanceToNextLeadEnabled
      });
      await onChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not archive campaign");
    } finally {
      setPending(false);
    }
  }

  async function resetLeads() {
    if (
      !window.confirm(
        `Reset all ${campaign.loaded.toLocaleString()} leads in "${campaign.name}"? They will become callable as new leads. Call history and the global suppression list will be preserved.`
      )
    ) {
      return;
    }
    setPending(true);
    setError(null);
    setResetMessage(null);
    try {
      const result = await resetCampaignLeads(campaign.id);
      setResetMessage(`${result.resetCount.toLocaleString()} leads reset.`);
      await onChanged();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Could not reset campaign leads");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header action-header">
        <div>
          <Upload size={18} />
          <h2>{campaign.name}</h2>
        </div>
        <div className="row-actions">
          <button
            className="icon-button"
            disabled={pending}
            onClick={() => setEditing((current) => !current)}
            title={editing ? "Cancel edit" : "Edit campaign"}
            type="button"
          >
            {editing ? <XCircle size={16} /> : <Pencil size={16} />}
          </button>
          <button
            className="icon-button danger-icon"
            disabled={pending || campaign.status === "archived"}
            onClick={archive}
            title="Archive campaign"
            type="button"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      {editing ? (
        <form className="campaign-edit-form" onSubmit={save}>
          <label>
            Name
            <input onChange={(event) => setName(event.target.value)} required value={name} />
          </label>
          <label>
            Status
            <select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
              <option value="draft">draft</option>
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="archived">archived</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input
              checked={autoAdvanceToNextLeadEnabled}
              onChange={(event) => setAutoAdvanceToNextLeadEnabled(event.target.checked)}
              type="checkbox"
            />
            Automatically call next lead
          </label>
          <label className="checkbox-label">
            <input
              checked={manualDialingEnabled}
              onChange={(event) => setManualDialingEnabled(event.target.checked)}
              type="checkbox"
            />
            Allow manual dialing
          </label>
          <label className="checkbox-label">
            <input
              checked={callRecordingEnabled}
              onChange={(event) => setCallRecordingEnabled(event.target.checked)}
              type="checkbox"
            />
            Record calls
          </label>
          <label className="checkbox-label">
            <input
              checked={earlyMediaAvmdEnabled}
              onChange={(event) => setEarlyMediaAvmdEnabled(event.target.checked)}
              type="checkbox"
            />
            Start AVMD during early media
          </label>
          {earlyMediaAvmdEnabled && (
            <p className="avmd-warning">
              May detect voicemail beeps before answer, but slightly increases the chance of false positives
              from carrier tones.
            </p>
          )}
          <button className="primary-action compact-action" disabled={pending} type="submit">
            <CheckCircle2 size={16} />
            {pending ? "Saving" : "Save"}
          </button>
          <button
            className="danger-action compact-action"
            disabled={pending}
            onClick={resetLeads}
            type="button"
          >
            <RefreshCw size={16} />
            Reset Leads
          </button>
        </form>
      ) : (
        <div className="campaign-badges">
          <StatusBadge label={campaign.status} tone="neutral" />
          {campaign.manualDialingEnabled && <StatusBadge label="Manual dialing" tone="neutral" />}
          {campaign.callRecordingEnabled && <StatusBadge label="Call recording" tone="good" />}
          {campaign.earlyMediaAvmdEnabled && <StatusBadge label="Early-media AVMD" tone="warn" />}
          {campaign.autoAdvanceToNextLeadEnabled && <StatusBadge label="Auto next lead" tone="good" />}
        </div>
      )}
      <div className="stat-row campaign-stat-row">
        <Metric label="Loaded" value={campaign.loaded} icon={Users} />
        <Metric label="Callable" value={campaign.callable} icon={PhoneCall} />
        <Metric label="Attempted" value={campaign.attempted} icon={History} />
      </div>
      {campaign.outcomeDistribution.length > 0 && (
        <div className="kpi-outcomes campaign-outcomes" aria-label="Campaign outcome breakdown">
          {campaign.outcomeDistribution.map((item) => (
            <span key={item.outcome}>
              <strong>{item.count}</strong> {item.outcome.replaceAll("_", " ")}
            </span>
          ))}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      {resetMessage && <p className="form-success">{resetMessage}</p>}
    </article>
  );
}
