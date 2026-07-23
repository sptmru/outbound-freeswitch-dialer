import { useEffect, useState } from "react";
import { getCallRecordingAudioUrl } from "../../api";
import { getErrorMessage } from "../../lib/errors";

export function CallRecordingPlayer({ callId, leadName }: { callId: string; leadName: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setUrl(null);
    setError(null);
    void getCallRecordingAudioUrl(callId)
      .then((nextUrl) => {
        if (active) setUrl(nextUrl);
      })
      .catch((loadError) => {
        if (active) setError(getErrorMessage(loadError, "Could not authorize recording playback"));
      });
    return () => {
      active = false;
    };
  }, [callId]);
  return (
    <div className="call-recording-player">
      <strong>Call recording</strong>
      {url ? (
        <audio aria-label={`Call recording for ${leadName}`} controls preload="metadata" src={url} />
      ) : (
        <span aria-live="polite">{error ?? "Preparing secure playback…"}</span>
      )}
    </div>
  );
}
