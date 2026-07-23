import { useState } from "react";
import type { FormEvent } from "react";
import { upsertCallAvmdReview } from "../../api";
import { StatusBadge } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import { formatDateTime } from "../../lib/formatters";
import type { CallAvmdReview, CallDetailResponse } from "../../types";
import { formatAvmdActualParty, formatAvmdPrediction } from "./history-formatters";

export function AvmdReviewCard({
  detail,
  onSaved
}: {
  detail: CallDetailResponse;
  onSaved: (review: CallAvmdReview) => void;
}) {
  const [actualParty, setActualParty] = useState<CallAvmdReview["actualParty"] | null>(
    detail.avmdReview?.actualParty ?? null
  );
  const [notes, setNotes] = useState(detail.avmdReview?.notes ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const canReview = detail.call.avmdAttempted && detail.call.recordingAvailable;

  async function saveReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!actualParty) {
      setError("Choose what answered the call");
      return;
    }
    if (actualParty === "uncertain" && !notes.trim()) {
      setError("Add a note explaining why the review is uncertain");
      return;
    }
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const review = await upsertCallAvmdReview(detail.call.id, {
        actualParty,
        notes: notes.trim() || undefined
      });
      onSaved(review);
      setSaved(true);
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Could not save AVMD review"));
    } finally {
      setPending(false);
    }
  }

  if (!detail.call.avmdAttempted && !detail.avmdReview) {
    return (
      <section className="avmd-review-card unavailable" aria-labelledby={`avmd-review-${detail.call.id}`}>
        <div>
          <strong id={`avmd-review-${detail.call.id}`}>AVMD review</strong>
          <span>AVMD was not started for this call; no review is needed.</span>
        </div>
      </section>
    );
  }

  if (!canReview) {
    return (
      <section className="avmd-review-card unavailable" aria-labelledby={`avmd-review-${detail.call.id}`}>
        <div>
          <strong id={`avmd-review-${detail.call.id}`}>AVMD review</strong>
          <span>Detector: {formatAvmdPrediction(detail)}</span>
        </div>
        {detail.avmdReview ? (
          <div className="avmd-review-existing">
            <StatusBadge label={formatAvmdActualParty(detail.avmdReview.actualParty)} tone="neutral" />
            <span>
              Reviewed by {detail.avmdReview.reviewedByName} · {formatDateTime(detail.avmdReview.reviewedAt)}
            </span>
            {detail.avmdReview.notes && <p>{detail.avmdReview.notes}</p>}
            <small>The recording is no longer available, so this review cannot be rechecked.</small>
          </div>
        ) : (
          <p>Review unavailable: this call has no playable recording.</p>
        )}
      </section>
    );
  }

  return (
    <section className="avmd-review-card" aria-labelledby={`avmd-review-${detail.call.id}`}>
      <div className="avmd-review-heading">
        <div>
          <strong id={`avmd-review-${detail.call.id}`}>AVMD review</strong>
          <span>Detector: {formatAvmdPrediction(detail)}</span>
        </div>
        {detail.avmdReview && (
          <small>
            Reviewed by {detail.avmdReview.reviewedByName} · {formatDateTime(detail.avmdReview.reviewedAt)}
          </small>
        )}
      </div>
      <p>
        Listen to the call recording, then classify what answered. This review evaluates the detector; it does
        not confirm voicemail delivery.
      </p>
      <form onSubmit={saveReview}>
        <fieldset>
          <legend>What answered?</legend>
          <div className="avmd-review-options">
            {(["human", "machine", "uncertain"] as const).map((value) => (
              <label className={actualParty === value ? "selected" : undefined} key={value}>
                <input
                  checked={actualParty === value}
                  name={`avmd-actual-party-${detail.call.id}`}
                  onChange={() => {
                    setActualParty(value);
                    setError(null);
                    setSaved(false);
                  }}
                  type="radio"
                  value={value}
                />
                {formatAvmdActualParty(value)}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          Review note{actualParty === "uncertain" ? " (required for Uncertain)" : " (optional)"}
          <textarea
            maxLength={1000}
            onChange={(event) => {
              setNotes(event.target.value);
              setSaved(false);
            }}
            placeholder="Add context that will help interpret this review"
            value={notes}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="inline-success" aria-live="polite">
            AVMD review saved
          </p>
        )}
        <button className="primary-action compact-action" disabled={pending} type="submit">
          {pending ? "Saving review" : detail.avmdReview ? "Update review" : "Save review"}
        </button>
      </form>
    </section>
  );
}
