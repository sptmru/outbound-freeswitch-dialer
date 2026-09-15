import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Upload, Users } from "lucide-react";
import { createCampaign, createContact } from "../../api";
import { PanelHeader } from "../../components/ui-primitives";
import type { AdminOverviewResponse } from "../../types";
import { getValidCampaignId } from "./campaigns-utils";

export function CreateCampaignForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"active" | "paused" | "draft">("draft");
  const [manualDialingEnabled, setManualDialingEnabled] = useState(true);
  const [callRecordingEnabled, setCallRecordingEnabled] = useState(true);
  const [earlyMediaAvmdEnabled, setEarlyMediaAvmdEnabled] = useState(false);
  const [autoAdvanceToNextLeadEnabled, setAutoAdvanceToNextLeadEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createCampaign({
        name,
        status,
        manualDialingEnabled,
        callRecordingEnabled,
        earlyMediaAvmdEnabled,
        autoAdvanceToNextLeadEnabled
      });
      setName("");
      setStatus("draft");
      setEarlyMediaAvmdEnabled(false);
      setAutoAdvanceToNextLeadEnabled(false);
      await onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not create campaign");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="panel form-panel">
      <PanelHeader icon={Upload} title="New campaign" meta="Create" />
      <form className="stack-form" onSubmit={submit}>
        <label>
          Name
          <input
            onChange={(event) => setName(event.target.value)}
            placeholder="Solar Follow-up"
            required
            value={name}
          />
        </label>
        <label>
          Status
          <select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="paused">paused</option>
          </select>
        </label>
        <div className="toggle-row">
          <label>
            <input
              checked={autoAdvanceToNextLeadEnabled}
              onChange={(event) => setAutoAdvanceToNextLeadEnabled(event.target.checked)}
              type="checkbox"
            />
            Auto next lead
          </label>
          <label>
            <input
              checked={manualDialingEnabled}
              onChange={(event) => setManualDialingEnabled(event.target.checked)}
              type="checkbox"
            />
            Manual dialing
          </label>
          <label>
            <input
              checked={callRecordingEnabled}
              onChange={(event) => setCallRecordingEnabled(event.target.checked)}
              type="checkbox"
            />
            Call recording
          </label>
          <label>
            <input
              checked={earlyMediaAvmdEnabled}
              onChange={(event) => setEarlyMediaAvmdEnabled(event.target.checked)}
              type="checkbox"
            />
            AVMD in early media
          </label>
        </div>
        {earlyMediaAvmdEnabled && (
          <p className="avmd-warning">
            May detect voicemail beeps before answer, but slightly increases the chance of false positives
            from carrier tones.
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-action" disabled={pending} type="submit">
          <Upload size={17} />
          {pending ? "Creating" : "Create campaign"}
        </button>
      </form>
    </article>
  );
}

export function CreateContactForm({
  campaigns,
  onChanged,
  selectedCampaignId
}: {
  campaigns: AdminOverviewResponse["campaigns"];
  onChanged: () => Promise<void>;
  selectedCampaignId: string | null;
}) {
  const [campaignId, setCampaignId] = useState(getValidCampaignId(selectedCampaignId ?? "", campaigns));
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [zohoLeadId, setZohoLeadId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const nextCampaignId = getValidCampaignId(campaignId, campaigns);
    if (nextCampaignId !== campaignId) {
      setCampaignId(nextCampaignId);
    }
  }, [campaignId, campaigns]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const leadId = zohoLeadId.trim();
      await createContact({
        campaignId,
        name,
        company: company || undefined,
        phoneNumber,
        fields: leadId ? [{ label: "lead_id", value: leadId }] : undefined
      });
      setName("");
      setCompany("");
      setPhoneNumber("");
      setZohoLeadId("");
      await onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not add lead");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="panel form-panel">
      <PanelHeader icon={Users} title="Add lead" meta="Queue" />
      <form className="stack-form" onSubmit={submit}>
        <label>
          Campaign
          <select
            disabled={!campaigns.length}
            onChange={(event) => setCampaignId(event.target.value)}
            required
            value={campaignId}
          >
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            onChange={(event) => setName(event.target.value)}
            placeholder="Avery Johnson"
            required
            value={name}
          />
        </label>
        <label>
          Phone
          <input
            onChange={(event) => setPhoneNumber(event.target.value)}
            placeholder="+1 415 555 0148"
            required
            value={phoneNumber}
          />
        </label>
        <label>
          Company
          <input
            onChange={(event) => setCompany(event.target.value)}
            placeholder="North Bay Solar"
            value={company}
          />
        </label>
        <label>
          Zoho Lead ID
          <input
            type="text"
            maxLength={400}
            onChange={(event) => setZohoLeadId(event.target.value)}
            placeholder="Optional"
            value={zohoLeadId}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-action" disabled={pending || !campaigns.length} type="submit">
          <Users size={17} />
          {pending ? "Adding" : "Add lead"}
        </button>
      </form>
    </article>
  );
}
