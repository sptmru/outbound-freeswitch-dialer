import { useState, type FormEvent } from "react";
import { uploadRecording } from "../../api";
import { getErrorMessage } from "../../lib/errors";
import type { AdminOverviewResponse } from "../../types";

export function VoicemailUpload({
  campaigns,
  initialCampaignId = "",
  onUploaded,
  onCancel
}: {
  campaigns: AdminOverviewResponse["campaigns"];
  initialCampaignId?: string;
  onUploaded: () => Promise<void>;
  onCancel: () => void;
}) {
  const [campaignId, setCampaignId] = useState(initialCampaignId);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [useForCampaign, setUseForCampaign] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !campaignId || pending) return;
    setPending(true);
    setError(null);
    try {
      await uploadRecording({
        file,
        name: name.trim() || file.name.replace(/\.[^.]+$/, ""),
        campaignId,
        useForCampaign
      });
      await onUploaded();
    } catch (error) {
      setError(getErrorMessage(error, "Could not upload voicemail"));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="stack-form" onSubmit={submit}>
      <label>
        Campaign
        <select
          required
          value={campaignId}
          disabled={pending || Boolean(initialCampaignId)}
          onChange={(event) => setCampaignId(event.target.value)}
        >
          <option value="">Choose a campaign</option>
          {campaigns
            .filter((c) => c.status !== "archived")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Voicemail file
        <input
          required
          disabled={pending}
          type="file"
          accept=".wav,.mp3,audio/wav,audio/mpeg"
          onChange={(event) => {
            const next = event.target.files?.[0] ?? null;
            setFile(next);
            if (next && !name.trim()) setName(next.name.replace(/\.[^.]+$/, ""));
          }}
        />
      </label>
      <label>
        Voicemail name
        <input
          value={name}
          disabled={pending}
          onChange={(event) => setName(event.target.value)}
          placeholder="Campaign voicemail"
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={useForCampaign}
          disabled={pending}
          onChange={(event) => setUseForCampaign(event.target.checked)}
        />
        Use for this campaign
      </label>
      <p>Applies to current calls that have not started a voicemail drop.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary-action" type="submit" disabled={pending || !file || !campaignId}>
        {pending ? "Uploading" : "Upload voicemail"}
      </button>
      <button className="secondary-action" type="button" disabled={pending} onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
