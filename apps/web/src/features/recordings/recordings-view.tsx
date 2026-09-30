import { useEffect, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clock3,
  FileAudio,
  Play,
  Search,
  Square,
  Trash2,
  Upload
} from "lucide-react";
import { deleteRecording, fetchAdminRecordings, getRecordingAudioUrl, setCampaignVoicemail } from "../../api";
import { AdminLibraryPagination } from "../../components/admin-library-pagination";
import { Metric } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import { formatBytes, formatDuration } from "../../lib/formatters";
import type { AdminOverviewResponse, AdminRecordingListResponse } from "../../types";

import { VoicemailUpload } from "./voicemail-upload";

export function Recordings({
  admin,
  onChanged
}: {
  admin: AdminOverviewResponse;
  onChanged: () => Promise<void>;
}) {
  const [campaignFilter, setCampaignFilter] = useState("");
  const [defaultPendingId, setDefaultPendingId] = useState<string | null>(null);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [libraryPending, setLibraryPending] = useState(false);
  const [library, setLibrary] = useState<AdminRecordingListResponse>({
    items: admin.recordings.slice(0, 25),
    page: 1,
    pageSize: 25,
    total: admin.recordings.length,
    totalPages: admin.recordings.length ? Math.ceil(admin.recordings.length / 25) : 0
  });
  const firstRecording = admin.recordings[0];
  const [selectedRecordingId, setSelectedRecordingId] = useState(firstRecording?.id ?? "");
  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    if (!admin.recordings.some((recording) => recording.id === selectedRecordingId)) {
      setSelectedRecordingId(firstRecording?.id ?? "");
    }
  }, [admin.recordings, firstRecording?.id, selectedRecordingId]);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setLibraryPending(true);
      setLibraryError(null);
      void fetchAdminRecordings({
        q: query || undefined,
        campaignId: campaignFilter || undefined,
        page,
        pageSize: 25
      })
        .then((next) => {
          if (active) setLibrary(next);
        })
        .catch((loadError) => {
          if (active) setLibraryError(getErrorMessage(loadError, "Could not load recording library"));
        })
        .finally(() => {
          if (active) setLibraryPending(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [admin.recordings, page, query, campaignFilter]);

  useEffect(() => {
    if (!preview) {
      return;
    }
    previewAudioRef.current?.play().catch(() => undefined);
  }, [preview]);

  async function assignRecording(recording: AdminOverviewResponse["recordings"][number]) {
    setDefaultPendingId(recording.id);
    setError(null);
    try {
      await setCampaignVoicemail(recording.campaignId, recording.isAssigned ? null : recording.id);
      await onChanged();
    } catch (error) {
      setError(getErrorMessage(error, "Could not update campaign voicemail"));
    } finally {
      setDefaultPendingId(null);
    }
  }

  async function removeRecording(recording: AdminOverviewResponse["recordings"][number]) {
    if (!window.confirm(`Delete ${recording.name}?`)) {
      return;
    }

    setDeletePendingId(recording.id);
    setError(null);
    try {
      await deleteRecording(recording.id);
      await onChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete recording");
    } finally {
      setDeletePendingId(null);
    }
  }

  async function togglePreview(recordingId: string) {
    if (preview?.id === recordingId) {
      setPreview(null);
      return;
    }

    setError(null);
    try {
      setPreview({ id: recordingId, url: await getRecordingAudioUrl(recordingId) });
    } catch (previewError) {
      setError(getErrorMessage(previewError, "Could not authorize voicemail preview"));
    }
  }

  const selectedRecording =
    admin.recordings.find((recording) => recording.id === selectedRecordingId) ?? firstRecording;
  const totalStorage = admin.recordings.reduce((total, recording) => total + recording.fileSizeBytes, 0);

  return (
    <div className="recordings-view">
      <div className="recording-stats">
        <Metric label="Active recordings" value={admin.recordings.length} icon={FileAudio} />
        <Metric
          label="Selected length"
          value={selectedRecording?.durationSeconds ? `${selectedRecording.durationSeconds} sec` : "—"}
          icon={Clock3}
        />
        <Metric label="Storage used" value={formatBytes(totalStorage)} icon={Activity} />
      </div>
      <div className="recordings-layout">
        <article className="panel recording-library-panel">
          <div className="recording-library-header">
            <div className="surface-heading">
              <h2>Recording library</h2>
              <p>Campaign voicemail messages managed by administrators</p>
            </div>
            <button
              className="primary-action compact-action"
              onClick={() => setShowUpload(true)}
              type="button"
            >
              <Upload size={16} />
              Upload recording
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
          {libraryError && <p className="form-error">{libraryError}</p>}
          <label className="queue-search">
            <Search size={15} />
            <input
              aria-label="Search recordings"
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Search recording name"
              value={query}
            />
          </label>
          <label className="stack-form">
            Filter by campaign
            <select
              value={campaignFilter}
              onChange={(event) => {
                setCampaignFilter(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All campaigns</option>
              {admin.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="recording-table-head" aria-hidden="true">
            <span>Name</span>
            <span>Duration</span>
            <span>Status</span>
            <span />
          </div>
          <div className="recording-library-list">
            {library.items.map((recording) => (
              <div
                className={
                  recording.id === selectedRecording?.id
                    ? "recording-library-row selected"
                    : "recording-library-row"
                }
                key={recording.id}
              >
                <button
                  className="recording-select-button"
                  onClick={() => {
                    setSelectedRecordingId(recording.id);
                    setShowUpload(false);
                  }}
                  type="button"
                >
                  <strong>{recording.name}</strong>
                  <small>
                    {recording.campaignName} · {formatBytes(recording.fileSizeBytes)}
                  </small>
                </button>
                <span>
                  {recording.durationSeconds ? formatDuration(recording.durationSeconds) : "Pending"}
                </span>
                <b>{recording.status}</b>
                <button
                  className="icon-button"
                  onClick={() => {
                    setSelectedRecordingId(recording.id);
                    setShowUpload(false);
                    void togglePreview(recording.id);
                  }}
                  title={preview?.id === recording.id ? "Stop preview" : "Preview voicemail"}
                  type="button"
                >
                  {preview?.id === recording.id ? <Square size={16} /> : <Play size={16} />}
                </button>
              </div>
            ))}
            {!library.items.length && <p className="empty-state">No recordings match this search.</p>}
          </div>
          <AdminLibraryPagination
            onPageChange={setPage}
            page={library.page}
            pending={libraryPending}
            totalPages={library.totalPages}
          />
        </article>
        <article className="panel recording-detail-panel">
          {showUpload ? (
            <>
              <div className="surface-heading">
                <span className="detail-eyebrow">New recording</span>
                <h2>Upload voicemail</h2>
                <p>WAV or MP3 audio for agent handoffs</p>
              </div>
              <VoicemailUpload
                campaigns={admin.campaigns}
                onUploaded={async () => {
                  await onChanged();
                  setShowUpload(false);
                }}
                onCancel={() => setShowUpload(false)}
              />
            </>
          ) : selectedRecording ? (
            <>
              <div className="surface-heading">
                <span className="detail-eyebrow">Selected recording</span>
                <h2>{selectedRecording.name}</h2>
                <p>
                  {selectedRecording.isAssigned
                    ? `Voicemail for ${selectedRecording.campaignName}`
                    : `Saved for ${selectedRecording.campaignName}`}
                </p>
              </div>
              <div className="recording-player-card">
                <button
                  className="recording-play-button"
                  onClick={() => void togglePreview(selectedRecording.id)}
                  type="button"
                  title="Preview voicemail"
                >
                  {preview?.id === selectedRecording.id ? <Square size={18} /> : <Play size={18} />}
                </button>
                <strong>
                  {selectedRecording.durationSeconds
                    ? `00:00 / ${formatDuration(selectedRecording.durationSeconds)}`
                    : "Duration pending"}
                </strong>
                <div className="mini-waveform" aria-hidden="true">
                  {[18, 28, 40, 22, 34, 48, 26, 38, 20, 44, 30, 42, 24, 36, 18, 32, 40, 22, 34, 18].map(
                    (height, index) => (
                      <span key={`${height}-${index}`} style={{ height }} />
                    )
                  )}
                </div>
                {preview?.id === selectedRecording.id && (
                  <audio autoPlay controls ref={previewAudioRef} src={preview.url} />
                )}
              </div>
              <div className="recording-default-card">
                <CheckCircle2 size={16} />
                <span>
                  {selectedRecording.isAssigned
                    ? "Used for this campaign’s voicemail drops"
                    : "Saved; not currently assigned"}
                </span>
              </div>
              <div className="recording-meta-list">
                <div>
                  <span>Duration</span>
                  <strong>
                    {selectedRecording.durationSeconds
                      ? formatDuration(selectedRecording.durationSeconds)
                      : "Pending"}
                  </strong>
                </div>
                <div>
                  <span>File size</span>
                  <strong>{formatBytes(selectedRecording.fileSizeBytes)}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>{selectedRecording.status}</strong>
                </div>
              </div>
              <div className="recording-detail-actions">
                <button
                  className="secondary-action"
                  disabled={
                    defaultPendingId === selectedRecording.id ||
                    admin.campaigns.find((c) => c.id === selectedRecording.campaignId)?.status === "archived"
                  }
                  onClick={() => void assignRecording(selectedRecording)}
                  type="button"
                >
                  <CheckCircle2 size={16} />
                  {defaultPendingId === selectedRecording.id
                    ? "Saving"
                    : selectedRecording.isAssigned
                      ? "Disable campaign voicemail"
                      : "Use for this campaign"}
                </button>
                <button
                  className="danger-action"
                  disabled={selectedRecording.isAssigned || deletePendingId === selectedRecording.id}
                  title={
                    selectedRecording.isAssigned
                      ? "Replace or disable campaign voicemail before deleting"
                      : undefined
                  }
                  onClick={() => void removeRecording(selectedRecording)}
                  type="button"
                >
                  <Trash2 size={16} />
                  Delete
                </button>
              </div>
            </>
          ) : (
            <p className="empty-state">Upload a recording to get started.</p>
          )}
        </article>
      </div>
    </div>
  );
}
