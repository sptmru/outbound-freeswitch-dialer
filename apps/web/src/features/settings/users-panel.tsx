import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Pencil, Search, UserCheck, UserPlus, UserX, Users } from "lucide-react";
import { createUser, fetchAdminUsers, updateUser } from "../../api";
import { AdminLibraryPagination } from "../../components/admin-library-pagination";
import { PanelHeader } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import type { AdminOverviewResponse, AdminUserListResponse } from "../../types";

export function UsersPanel({
  onChanged,
  users
}: {
  onChanged: () => Promise<void>;
  users: AdminOverviewResponse["users"];
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<AdminUserListResponse>({
    items: users.slice(0, 25),
    page: 1,
    pageSize: 25,
    total: users.length,
    totalPages: users.length ? Math.ceil(users.length / 25) : 0
  });

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setPending(true);
      setError(null);
      void fetchAdminUsers({ q: query || undefined, page, pageSize: 25 })
        .then((next) => {
          if (active) setList(next);
        })
        .catch((loadError) => {
          if (active) setError(getErrorMessage(loadError, "Could not load users"));
        })
        .finally(() => {
          if (active) setPending(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [page, query, users]);

  return (
    <article className="panel users-panel">
      <PanelHeader icon={Users} title="Users" meta={pending ? "loading" : `${list.total} seats`} />
      <CreateUserForm onChanged={onChanged} />
      <label className="queue-search">
        <Search size={15} />
        <input
          aria-label="Search users"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder="Search name, email, role, Caller ID or status"
          value={query}
        />
      </label>
      {error && <p className="form-error">{error}</p>}
      <UserList onChanged={onChanged} users={list.items} />
      {!list.items.length && <p className="empty-state">No users match this search.</p>}
      <AdminLibraryPagination
        onPageChange={setPage}
        page={list.page}
        pending={pending}
        totalPages={list.totalPages}
      />
    </article>
  );
}

function UserList({
  onChanged,
  users
}: {
  onChanged: () => Promise<void>;
  users: AdminOverviewResponse["users"];
}) {
  return (
    <div className="table-list">
      {users.map((user) => (
        <UserRow key={user.id} onChanged={onChanged} user={user} />
      ))}
    </div>
  );
}

function UserRow({
  onChanged,
  user
}: {
  onChanged: () => Promise<void>;
  user: AdminOverviewResponse["users"][number];
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState(user.role);
  const [password, setPassword] = useState("");
  const [callerId, setCallerId] = useState(user.callerId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await updateUser(user.id, {
        name,
        email,
        role,
        callerId: callerId.trim() || null,
        ...(password ? { password } : {})
      });
      setPassword("");
      setEditing(false);
      await onChanged();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Could not update user"));
    } finally {
      setPending(false);
    }
  }

  async function toggleActive() {
    const action = user.isActive ? "deactivate" : "reactivate";
    if (user.isActive && !window.confirm(`Deactivate ${user.name}? Their call history will be preserved.`)) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await updateUser(user.id, { isActive: !user.isActive });
      await onChanged();
    } catch (updateError) {
      setError(getErrorMessage(updateError, `Could not ${action} user`));
    } finally {
      setPending(false);
    }
  }

  if (editing) {
    return (
      <form className="user-edit-form" onSubmit={save}>
        <div className="inline-fields">
          <label>
            Name
            <input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Role
            <select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
              <option value="agent">agent</option>
              <option value="admin">admin</option>
            </select>
          </label>
        </div>
        <label>
          Email
          <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        {(role === "agent" || user.agentRegistered !== null) && (
          <label>
            Caller ID
            <input
              maxLength={80}
              onChange={(event) => setCallerId(event.target.value)}
              placeholder="Blank uses the default Caller ID"
              value={callerId}
            />
          </label>
        )}
        <label>
          New password
          <input
            minLength={12}
            type="password"
            value={password}
            placeholder="Leave blank to keep current password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="row-actions">
          <button className="primary-action compact-action" disabled={pending} type="submit">
            Save
          </button>
          <button
            className="secondary-action compact-action"
            disabled={pending}
            onClick={() => setEditing(false)}
            type="button"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <>
      <div className={`table-row user-row ${user.isActive ? "" : "inactive"}`}>
        <strong>{user.name}</strong>
        <span>{user.email}</span>
        <b>
          {user.role} · {user.isActive ? "active" : "inactive"}
          {user.agentRegistered !== null ? ` · phone ${user.agentRegistered ? "connected" : "offline"}` : ""}
          {(user.role === "agent" || user.agentRegistered !== null) &&
            ` · Caller ID ${user.callerId ?? "default"}`}
        </b>
        <div className="row-actions">
          <button
            className="icon-button"
            disabled={pending}
            onClick={() => setEditing(true)}
            title="Edit user"
            type="button"
          >
            <Pencil size={16} />
          </button>
          <button
            className={user.isActive ? "icon-button danger-icon" : "icon-button"}
            disabled={pending}
            onClick={() => void toggleActive()}
            title={user.isActive ? "Deactivate user" : "Reactivate user"}
            type="button"
          >
            {user.isActive ? <UserX size={16} /> : <UserCheck size={16} />}
          </button>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function CreateUserForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"agent" | "admin">("agent");
  const [password, setPassword] = useState("");
  const [callerId, setCallerId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createUser({
        email,
        name,
        role,
        password,
        ...(role === "agent" ? { callerId: callerId.trim() || null } : {})
      });
      setEmail("");
      setName("");
      setPassword("");
      setCallerId("");
      await onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not create user");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack-form user-create-form" onSubmit={submit}>
      <div className="inline-fields">
        <label>
          Name
          <input
            onChange={(event) => setName(event.target.value)}
            placeholder="Agent name"
            required
            value={name}
          />
        </label>
        <label>
          Role
          <select onChange={(event) => setRole(event.target.value as typeof role)} value={role}>
            <option value="agent">agent</option>
            <option value="admin">admin</option>
          </select>
        </label>
      </div>
      <label>
        Email
        <input
          onChange={(event) => setEmail(event.target.value)}
          placeholder="agent@example.com"
          required
          type="email"
          value={email}
        />
      </label>
      {role === "agent" && (
        <label>
          Caller ID
          <input
            maxLength={80}
            onChange={(event) => setCallerId(event.target.value)}
            placeholder="Blank uses the default Caller ID"
            value={callerId}
          />
        </label>
      )}
      <label>
        Password
        <input
          minLength={12}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 12 characters"
          required
          type="password"
          value={password}
        />
      </label>
      {error && <p className="form-error">{error}</p>}
      <button className="primary-action" disabled={pending} type="submit">
        <UserPlus size={17} />
        {pending ? "Creating" : "Create user"}
      </button>
    </form>
  );
}
