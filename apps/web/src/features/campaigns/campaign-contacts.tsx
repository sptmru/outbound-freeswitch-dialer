import { useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, PhoneCall, Users } from "lucide-react";
import { completeContact, fetchCampaignContacts, suppressContact } from "../../api";
import { AdminLibraryPagination } from "../../components/admin-library-pagination";
import { PanelHeader } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import { getDisplayCompany } from "../../lib/lead-formatters";
import type { AdminOverviewResponse, CampaignContactListItem, CampaignContactsResponse } from "../../types";
import { getValidCampaignId } from "./campaigns-utils";

export function CampaignContacts({
  campaigns,
  onChanged,
  onManualDial,
  selectedCampaignId
}: {
  campaigns: AdminOverviewResponse["campaigns"];
  onChanged: () => Promise<void>;
  onManualDial: (phoneNumber: string) => void;
  selectedCampaignId: string | null;
}) {
  const [campaignId, setCampaignId] = useState(getValidCampaignId(selectedCampaignId ?? "", campaigns));
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "ready" | "suppressed" | "completed">("all");
  const [page, setPage] = useState(1);
  const [contacts, setContacts] = useState<CampaignContactsResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const contactsRequestRef = useRef(0);

  useEffect(() => {
    const nextCampaignId = getValidCampaignId(campaignId, campaigns);
    if (nextCampaignId !== campaignId) {
      setCampaignId(nextCampaignId);
      setPage(1);
    }
  }, [campaignId, campaigns]);

  useEffect(() => {
    if (!campaignId) {
      contactsRequestRef.current += 1;
      setContacts(null);
      setPending(false);
      return;
    }

    const requestId = ++contactsRequestRef.current;
    const timeout = window.setTimeout(() => {
      setPending(true);
      setError(null);
      fetchCampaignContacts(campaignId, { q: query, status, page, pageSize: 50 })
        .then((nextContacts) => {
          if (requestId === contactsRequestRef.current) {
            if (page > Math.max(nextContacts.totalPages, 1)) {
              setPage(Math.max(nextContacts.totalPages, 1));
              return;
            }
            setContacts(nextContacts);
          }
        })
        .catch((loadError: unknown) => {
          if (requestId === contactsRequestRef.current) {
            setError(getErrorMessage(loadError, "Could not load contacts"));
          }
        })
        .finally(() => {
          if (requestId === contactsRequestRef.current) {
            setPending(false);
          }
        });
    }, 180);

    return () => {
      contactsRequestRef.current += 1;
      window.clearTimeout(timeout);
    };
  }, [campaignId, page, query, reloadKey, status]);

  async function runContactAction(
    contact: CampaignContactListItem,
    action: (contact: CampaignContactListItem) => Promise<unknown>
  ) {
    setActionId(contact.id);
    setError(null);
    try {
      await action(contact);
      setReloadKey((current) => current + 1);
      await onChanged();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not update contact");
    } finally {
      setActionId(null);
    }
  }

  return (
    <article className="panel wide-panel contact-browser">
      <PanelHeader
        icon={Users}
        title="Campaign contacts"
        meta={pending ? "loading" : `${contacts?.total ?? 0} found`}
      />
      <div className="contact-toolbar">
        <label>
          Campaign
          <select
            disabled={!campaigns.length}
            onChange={(event) => {
              setCampaignId(event.target.value);
              setPage(1);
            }}
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
          Search
          <input
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Name, phone, company"
            value={query}
          />
        </label>
        <label>
          Status
          <select
            onChange={(event) => {
              setStatus(event.target.value as typeof status);
              setPage(1);
            }}
            value={status}
          >
            <option value="all">all</option>
            <option value="ready">ready</option>
            <option value="suppressed">suppressed</option>
            <option value="completed">completed</option>
          </select>
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="table-list">
        {contacts?.contacts.length === 0 && <div className="empty-row">No contacts match this filter</div>}
        {contacts?.contacts.map((contact) => (
          <div className="table-row contact-row" key={contact.id}>
            <strong>{contact.name}</strong>
            <span>{getDisplayCompany(contact.company)}</span>
            <span>{contact.phoneNumber}</span>
            <b>{contact.status}</b>
            <div className="row-actions">
              <button
                className="icon-button"
                onClick={() => onManualDial(contact.phoneNumber)}
                title="Send to manual dial"
                type="button"
              >
                <PhoneCall size={16} />
              </button>
              <button
                className="icon-button"
                disabled={actionId === contact.id || contact.status === "completed"}
                onClick={() => runContactAction(contact, (item) => completeContact(item.id))}
                title="Mark completed"
                type="button"
              >
                <CheckCircle2 size={16} />
              </button>
              <button
                className="icon-button danger-icon"
                disabled={actionId === contact.id || contact.status === "suppressed"}
                onClick={() =>
                  runContactAction(contact, (item) =>
                    suppressContact(item.id, { reason: "Suppressed from campaign contact list" })
                  )
                }
                title="Suppress"
                type="button"
              >
                <Ban size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <AdminLibraryPagination
        onPageChange={setPage}
        page={contacts?.page ?? page}
        pending={pending}
        totalPages={contacts?.totalPages ?? 0}
      />
    </article>
  );
}
