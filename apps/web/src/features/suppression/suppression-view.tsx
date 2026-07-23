import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Ban, Search, Trash2, Upload } from "lucide-react";
import { createSuppression, deleteSuppression, fetchSuppression, importSuppressionCsvFile } from "../../api";
import { PanelHeader } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import type { AdminOverviewResponse, SuppressionListResponse } from "../../types";

export function SuppressionView({
  admin,
  onChanged
}: {
  admin: AdminOverviewResponse;
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<SuppressionListResponse>({
    items: admin.suppression,
    page: 1,
    pageSize: 25,
    total: admin.suppression.length,
    totalPages: admin.suppression.length ? 1 : 0
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setPending(true);
      void fetchSuppression({ q: query || undefined, page, pageSize: 25 })
        .then((next) => {
          if (active) setList(next);
        })
        .catch((loadError) => {
          if (active) setError(getErrorMessage(loadError, "Could not load suppression list"));
        })
        .finally(() => {
          if (active) setPending(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [admin.suppression, page, query]);

  return (
    <div className="operations-grid two">
      <CreateSuppressionForm onChanged={onChanged} />
      <SuppressionCsvImport onChanged={onChanged} />
      <article className="panel">
        <PanelHeader
          icon={Ban}
          title="Suppressed numbers"
          meta={pending ? "loading" : `${list.total} entries`}
        />
        <label className="queue-search">
          <Search size={15} />
          <input
            aria-label="Search suppressed numbers"
            placeholder="Search number or reason"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="table-list">
          {list.items.map((item) => (
            <SuppressionRow item={item} key={item.id} onChanged={onChanged} />
          ))}
          {list.items.length === 0 && <div className="empty-row">No suppressed numbers match</div>}
        </div>
        <div className="pagination-controls">
          <button
            className="secondary-action compact-action"
            disabled={page <= 1 || pending}
            onClick={() => setPage((current) => current - 1)}
            type="button"
          >
            Previous
          </button>
          <span>
            Page {list.page} of {Math.max(list.totalPages, 1)}
          </span>
          <button
            className="secondary-action compact-action"
            disabled={page >= list.totalPages || pending}
            onClick={() => setPage((current) => current + 1)}
            type="button"
          >
            Next
          </button>
        </div>
      </article>
    </div>
  );
}

function SuppressionRow({
  item,
  onChanged
}: {
  item: AdminOverviewResponse["suppression"][number];
  onChanged: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (
      !window.confirm(`Remove ${item.phoneNumber} from suppression? This action is written to the audit log.`)
    ) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await deleteSuppression(item.id);
      await onChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete suppression entry");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="table-row suppression-row">
        <strong>{item.phoneNumber}</strong>
        <span>{item.reason}</span>
        <button
          className="icon-button danger-icon"
          disabled={pending}
          onClick={remove}
          title="Remove suppression"
          type="button"
        >
          <Trash2 size={16} />
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </>
  );
}

function SuppressionCsvImport({ onChanged }: { onChanged: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const imported = await importSuppressionCsvFile(file);
      setResult(
        `${imported.importedRows} added · ${imported.updatedRows} updated · ${imported.failedRows} failed`
      );
      setFile(null);
      await onChanged();
    } catch (importError) {
      setError(getErrorMessage(importError, "Could not import suppression CSV"));
    } finally {
      setPending(false);
    }
  }
  return (
    <article className="panel form-panel">
      <PanelHeader icon={Upload} title="Import suppression CSV" meta="phone + optional reason" />
      <form className="stack-form" onSubmit={submit}>
        <label>
          CSV file
          <input
            accept=".csv,text/csv"
            required
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        {result && (
          <p className="copy-note" aria-live="polite">
            {result}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary-action" disabled={!file || pending} type="submit">
          <Upload size={17} />
          {pending ? "Importing" : "Import CSV"}
        </button>
      </form>
    </article>
  );
}

function CreateSuppressionForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createSuppression({ phoneNumber, reason: reason || undefined });
      setPhoneNumber("");
      setReason("");
      await onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not suppress number");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="panel form-panel">
      <PanelHeader icon={Ban} title="Suppress number" meta="DNC" />
      <form className="stack-form" onSubmit={submit}>
        <label>
          Phone
          <input
            onChange={(event) => setPhoneNumber(event.target.value)}
            placeholder="+1 408 555 0120"
            required
            value={phoneNumber}
          />
        </label>
        <label>
          Reason
          <input
            onChange={(event) => setReason(event.target.value)}
            placeholder="Do not call request"
            value={reason}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="danger-action" disabled={pending} type="submit">
          <Ban size={17} />
          {pending ? "Saving" : "Suppress"}
        </button>
      </form>
    </article>
  );
}
