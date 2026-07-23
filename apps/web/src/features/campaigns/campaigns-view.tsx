import { useEffect, useState } from "react";
import { Search, Upload } from "lucide-react";
import { fetchAdminCampaigns } from "../../api";
import { AdminLibraryPagination } from "../../components/admin-library-pagination";
import { PanelHeader } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import type { AdminCampaignListResponse, AdminOverviewResponse, CsvImportSummary } from "../../types";
import { CampaignCard } from "./campaign-card";
import { CampaignContacts } from "./campaign-contacts";
import { CreateCampaignForm, CreateContactForm } from "./campaign-forms";
import { CsvImportForm, CsvImportHistory } from "./campaign-imports";

export function Campaigns({
  admin,
  csvImports,
  onChanged,
  onManualDial,
  selectedCampaignId
}: {
  admin: AdminOverviewResponse;
  csvImports: CsvImportSummary[];
  onChanged: () => Promise<void>;
  onManualDial: (phoneNumber: string) => void;
  selectedCampaignId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [library, setLibrary] = useState<AdminCampaignListResponse>({
    items: admin.campaigns.slice(0, 25),
    page: 1,
    pageSize: 25,
    total: admin.campaigns.length,
    totalPages: admin.campaigns.length ? Math.ceil(admin.campaigns.length / 25) : 0
  });

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setPending(true);
      setLibraryError(null);
      void fetchAdminCampaigns({ q: query || undefined, page, pageSize: 25 })
        .then((next) => {
          if (active) setLibrary(next);
        })
        .catch((loadError) => {
          if (active) setLibraryError(getErrorMessage(loadError, "Could not load campaign library"));
        })
        .finally(() => {
          if (active) setPending(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [admin.campaigns, page, query]);

  return (
    <>
      <div className="operations-grid two">
        <CreateCampaignForm onChanged={onChanged} />
        <CreateContactForm
          campaigns={admin.campaigns}
          onChanged={onChanged}
          selectedCampaignId={selectedCampaignId}
        />
      </div>
      <div className="operations-grid two">
        <CsvImportForm
          campaigns={admin.campaigns}
          onChanged={onChanged}
          selectedCampaignId={selectedCampaignId}
        />
        <CsvImportHistory imports={csvImports} />
      </div>
      <article className="panel admin-library-toolbar">
        <PanelHeader
          icon={Upload}
          title="Campaign library"
          meta={pending ? "loading" : `${library.total} campaigns`}
        />
        <label className="queue-search">
          <Search size={15} />
          <input
            aria-label="Search campaigns"
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Search name or status"
            value={query}
          />
        </label>
        {libraryError && <p className="form-error">{libraryError}</p>}
        <AdminLibraryPagination
          onPageChange={setPage}
          page={library.page}
          pending={pending}
          totalPages={library.totalPages}
        />
      </article>
      <div className="operations-grid">
        {library.items.map((campaign) => (
          <CampaignCard campaign={campaign} key={campaign.id} onChanged={onChanged} />
        ))}
        {!library.items.length && <p className="empty-state">No campaigns match this search.</p>}
      </div>
      <CampaignContacts
        campaigns={admin.campaigns}
        onChanged={onChanged}
        onManualDial={onManualDial}
        selectedCampaignId={selectedCampaignId}
      />
    </>
  );
}
