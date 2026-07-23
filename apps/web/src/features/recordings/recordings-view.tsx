import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
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
import {
  deleteRecording,
  fetchAdminRecordings,
  getRecordingAudioUrl,
  setDefaultRecording,
  uploadRecording
} from "../../api";
import { AdminLibraryPagination } from "../../components/admin-library-pagination";
import { Metric } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import { formatBytes, formatDuration } from "../../lib/formatters";
import type { AdminOverviewResponse, AdminRecordingListResponse } from "../../types";

export function Recordings({
  admin,
  onChanged
}: {
  admin: AdminOverviewResponse;
  onChanged: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);
  const [pending, setPending] = useState(false);
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
  const defaultRecording =
    admin.recordings.find((recording) => recording.status === "default") ?? admin.recordings[0];
  const [selectedRecordingId, setSelectedRecordingId] = useState(defaultRecording?.id ?? "");
  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    if (!admin.recordings.some((recording) => recording.id === selectedRecordingId)) {
      setSelectedRecordingId(defaultRecording?.id ?? "");
    }
  }, [admin.recordings, defaultRecording?.id, selectedRecordingId]);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setLibraryPending(true);
      setLibraryError(null);
      void fetchAdminRecordings({ q: query || undefined, page, pageSize: 25 })
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
  }, [admin.recordings, page, query]);

  useEffect(() => {
    if (!preview) {
      return;
    }
    previewAudioRef.current?.play().catch(() => undefined);
  }, [preview]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file) {
      setError("Choose a WAV or MP3 file");
      return;
    }

    setPending(true);
    setError(null);
    try {
      await uploadRecording({
        file,
        name: name.trim() || file.name.replace(/\.[^.]+$/, ""),
        makeDefault
      });
      setFile(null);
      setName("");
      setMakeDefault(true);
      setShowUpload(false);
      form.reset();
      await onChanged();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Unable to upload recording");
    } finally {
      setPending(false);
    }
  }

  async function makeRecordingDefault(recordingId: string) {
    setDefaultPendingId(recordingId);
    setError(null);
    try {
      await setDefaultRecording(recordingId);
      await onChanged();
    } catch (defaultError) {
      setError(defaultError instanceof Error ? defaultError.message : "Unable to set default recording");
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
    admin.recordings.find((recording) => recording.id === selectedRecordingId) ?? defaultRecording;
  const totalStorage = admin.recordings.reduce((total, recording) => total + recording.fileSizeBytes, 0);

  return (
    <div className="recordings-view">
      <div className="recording-stats">
        <Metric label="Active recordings" value={admin.recordings.length} icon={FileAudio} />
        <Metric
          label="Default length"
          value={defaultRecording?.durationSeconds ? `${defaultRecording.durationSeconds} sec` : "—"}
          icon={Clock3}
        />
        <Metric label="Storage used" value={formatBytes(totalStorage)} icon={Activity} />
      </div>
      <div className="recordings-layout">
        <article className="panel recording-library-panel">
          <div className="recording-library-header">
            <div className="surface-heading">
              <h2>Recording library</h2>
              <p>Versioned audio files available to agents</p>
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
                  <small>{formatBytes(recording.fileSizeBytes)}</small>
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
              <form className="stack-form" onSubmit={submit}>
                <label>
                  Voicemail file
                  <input
                    accept=".wav,.mp3,audio/wav,audio/mpeg"
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0] ?? null;
                      setFile(nextFile);
                      if (nextFile && !name.trim()) setName(nextFile.name.replace(/\.[^.]+$/, ""));
                    }}
                    required
                    type="file"
                  />
                </label>
                <label>
                  Voicemail name
                  <input
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Main voicemail"
                    value={name}
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    checked={makeDefault}
                    onChange={(event) => setMakeDefault(event.target.checked)}
                    type="checkbox"
                  />
                  Make default
                </label>
                {error && <p className="form-error">{error}</p>}
                <button className="primary-action" disabled={pending || !file} type="submit">
                  <Upload size={17} />
                  {pending ? "Uploading" : "Upload voicemail"}
                </button>
                <button className="secondary-action" onClick={() => setShowUpload(false)} type="button">
                  Cancel
                </button>
              </form>
            </>
          ) : selectedRecording ? (
            <>
              <div className="surface-heading">
                <span className="detail-eyebrow">Selected recording</span>
                <h2>{selectedRecording.name}</h2>
                <p>
                  {selectedRecording.status === "default"
                    ? "Default voicemail"
                    : "Available for agent handoffs"}
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
                  {selectedRecording.status === "default"
                    ? "Default for new calls"
                    : "Ready to use in active calls"}
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
                    selectedRecording.status === "default" || defaultPendingId === selectedRecording.id
                  }
                  onClick={() => void makeRecordingDefault(selectedRecording.id)}
                  type="button"
                >
                  <CheckCircle2 size={16} />
                  {defaultPendingId === selectedRecording.id ? "Saving" : "Make default"}
                </button>
                <button
                  className="danger-action"
                  disabled={deletePendingId === selectedRecording.id}
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
