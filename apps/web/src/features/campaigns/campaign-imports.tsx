import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { History, Search, Upload } from "lucide-react";
import { fetchCsvImportDetail, fetchCsvImports, importCampaignCsvFile } from "../../api";
import { AdminLibraryPagination } from "../../components/admin-library-pagination";
import { PanelHeader } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import type {
  AdminOverviewResponse,
  CsvImportDetailResponse,
  CsvImportHistoryResponse,
  CsvImportSummary,
  ImportCsvResponse
} from "../../types";
import { getValidCampaignId } from "./campaigns-utils";

export function CsvImportForm({
  campaigns,
  onChanged,
  selectedCampaignId
}: {
  campaigns: AdminOverviewResponse["campaigns"];
  onChanged: () => Promise<void>;
  selectedCampaignId: string | null;
}) {
  const [campaignId, setCampaignId] = useState(getValidCampaignId(selectedCampaignId ?? "", campaigns));
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportCsvResponse | null>(null);

  useEffect(() => {
    const nextCampaignId = getValidCampaignId(campaignId, campaigns);
    if (nextCampaignId !== campaignId) {
      setCampaignId(nextCampaignId);
    }
  }, [campaignId, campaigns]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setError("Choose a CSV file first");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const importResult = await importCampaignCsvFile(campaignId, file);
      setResult(importResult);
      setFile(null);
      await onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not upload CSV");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="panel form-panel">
      <PanelHeader icon={Upload} title="CSV import" meta="Name + phone" />
      <form className="stack-form" onSubmit={submit}>
        <p className="form-help">
          Upload a CSV with <strong>name</strong> and <strong>phone</strong> columns. Phone is required for
          every imported lead.
        </p>
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
          CSV file
          <input
            accept=".csv,text/csv"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
              setResult(null);
            }}
            type="file"
          />
        </label>
        {file && (
          <p className="selected-file">
            Ready to import: <strong>{file.name}</strong>
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        {result && (
          <div
            className={result.failedRows ? "import-result has-failures" : "import-result success"}
            role="status"
          >
            <strong>
              {result.importedRows} lead{result.importedRows === 1 ? "" : "s"} imported
            </strong>
            <span>
              {result.failedRows
                ? `${result.failedRows} row${result.failedRows === 1 ? "" : "s"} could not be imported from ${result.totalRows} total`
                : `All ${result.totalRows} rows were accepted`}
            </span>
          </div>
        )}
        <button className="primary-action" disabled={pending || !campaigns.length || !file} type="submit">
          <Upload size={17} />
          {pending ? "Uploading" : "Upload CSV file"}
        </button>
      </form>
    </article>
  );
}

export function CsvImportHistory({ imports }: { imports: CsvImportSummary[] }) {
  const [selected, setSelected] = useState<CsvImportDetailResponse | null>(null);
  const [selectedImportId, setSelectedImportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [listPending, setListPending] = useState(false);
  const [list, setList] = useState<CsvImportHistoryResponse>({
    imports,
    page: 1,
    pageSize: 20,
    total: imports.length,
    totalPages: imports.length ? Math.ceil(imports.length / 20) : 0
  });

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setListPending(true);
      void fetchCsvImports({ q: query || undefined, page, pageSize: 20 })
        .then((next) => {
          if (active) setList(next);
        })
        .catch((loadError) => {
          if (active) setError(getErrorMessage(loadError, "Could not load CSV import history"));
        })
        .finally(() => {
          if (active) setListPending(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [imports, page, query]);

  async function selectImport(importId: string, failurePage = 1) {
    setSelectedImportId(importId);
    setPendingId(importId);
    setError(null);
    try {
      setSelected(await fetchCsvImportDetail(importId, { failurePage, failurePageSize: 50 }));
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "Could not load import detail");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <article className="panel">
      <PanelHeader
        icon={History}
        title="Import history"
        meta={listPending ? "loading" : `${list.total} runs`}
      />
      <label className="queue-search">
        <Search size={15} />
        <input
          aria-label="Search CSV imports"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder="Search file, campaign or status"
          value={query}
        />
      </label>
      <div className="table-list">
        {list.imports.length === 0 && <div className="empty-row">No imports match this search</div>}
        {list.imports.map((item) => (
          <button
            className="table-row import-row clickable-row"
            key={item.id}
            onClick={() => selectImport(item.id)}
            type="button"
          >
            <strong>{item.filename}</strong>
            <span>{item.campaignName}</span>
            <span>
              {item.importedRows}/{item.totalRows}
            </span>
            <b>{pendingId === item.id ? "loading" : item.status}</b>
          </button>
        ))}
      </div>
      <AdminLibraryPagination
        onPageChange={setPage}
        page={list.page}
        pending={listPending}
        totalPages={list.totalPages}
      />
      {error && <p className="form-error">{error}</p>}
      {selected && (
        <div className="import-detail">
          <div className="import-result">
            <strong>{selected.import.importedRows} imported</strong>
            <span>
              {selected.import.failedRows} failed, {selected.import.duplicateRows} duplicates
            </span>
          </div>
          <div className="table-list">
            {selected.failures.length === 0 && <div className="empty-row">No failed rows</div>}
            {selected.failures.map((failure) => (
              <div className="table-row failure-row" key={failure.id}>
                <strong>Row {failure.rowNumber}</strong>
                <span>{failure.reason}</span>
                <span>{Object.values(failure.row).filter(Boolean).slice(0, 3).join(" | ")}</span>
              </div>
            ))}
          </div>
          <AdminLibraryPagination
            onPageChange={(nextPage) => {
              if (selectedImportId) void selectImport(selectedImportId, nextPage);
            }}
            page={selected.failurePage}
            pending={pendingId === selectedImportId}
            totalPages={selected.failureTotalPages}
          />
        </div>
      )}
    </article>
  );
}
