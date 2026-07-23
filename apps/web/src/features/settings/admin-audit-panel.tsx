import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { fetchAdminAudit } from "../../api";
import { PanelHeader, StatusBadge } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import { formatDateTime } from "../../lib/formatters";
import type { AdminAuditResponse, PublicUser } from "../../types";

function historyDateBoundary(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (endOfDay) {
    date.setDate(date.getDate() + 1);
    date.setMilliseconds(-1);
  }
  return date.toISOString();
}

export function AdminAuditPanel({ users }: { users: PublicUser[] }) {
  const [page, setPage] = useState(1);
  const [actorId, setActorId] = useState("");
  const [method, setMethod] = useState<"" | "DELETE" | "PATCH" | "POST" | "PUT">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [audit, setAudit] = useState<AdminAuditResponse>({ page: 1, pageSize: 25, total: 0, items: [] });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    setPending(true);
    void fetchAdminAudit({
      page,
      pageSize: 25,
      actorId: actorId || undefined,
      method: method || undefined,
      dateFrom: historyDateBoundary(dateFrom, false),
      dateTo: historyDateBoundary(dateTo, true)
    })
      .then((next) => {
        if (active) setAudit(next);
      })
      .catch((loadError) => {
        if (active) setError(getErrorMessage(loadError, "Could not load admin audit"));
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [actorId, dateFrom, dateTo, method, page]);

  const totalPages = audit.total ? Math.ceil(audit.total / audit.pageSize) : 0;
  return (
    <article className="panel admin-audit-panel">
      <PanelHeader icon={Shield} title="Admin audit" meta={pending ? "loading" : `${audit.total} events`} />
      <div className="history-filters compact-filters">
        <label>
          Actor
          <select
            value={actorId}
            onChange={(event) => {
              setActorId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All admins</option>
            {users
              .filter((user) => user.role === "admin")
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Action
          <select
            value={method}
            onChange={(event) => {
              setMethod(event.target.value as typeof method);
              setPage(1);
            }}
          >
            <option value="">All changes</option>
            {["POST", "PATCH", "PUT", "DELETE"].map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            onChange={(event) => {
              setDateFrom(event.target.value);
              setPage(1);
            }}
            type="date"
            value={dateFrom}
          />
        </label>
        <label>
          To
          <input
            onChange={(event) => {
              setDateTo(event.target.value);
              setPage(1);
            }}
            type="date"
            value={dateTo}
          />
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="table-list">
        {audit.items.map((item) => (
          <div className="table-row audit-row" key={item.id}>
            <span>
              <strong>{item.actorName}</strong>
              <small>{formatDateTime(item.createdAt)}</small>
            </span>
            <span>
              <strong>{item.method}</strong>
              <small>{item.route}</small>
            </span>
            <StatusBadge label={String(item.statusCode)} tone="neutral" />
          </div>
        ))}
        {!audit.items.length && !pending && <div className="empty-row">No admin changes match</div>}
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
          Page {audit.page} of {Math.max(totalPages, 1)}
        </span>
        <button
          className="secondary-action compact-action"
          disabled={page >= totalPages || pending}
          onClick={() => setPage((current) => current + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </article>
  );
}
