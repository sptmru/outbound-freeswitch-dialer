import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadCallHistoryCsv,
  fetchAdminAudit,
  fetchAdminCampaigns,
  fetchAdminRecordings,
  fetchAdminUsers,
  fetchCampaignContacts,
  fetchCsvImportDetail,
  fetchCsvImports,
  fetchMe,
  logout,
  subscribeAgentEvents,
  upsertCallAvmdReview
} from "./api";

describe("cookie-authenticated API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends same-origin credentials without reading a bearer token from localStorage", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ user: { id: "user-1" } }),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem("outbound_dialer_token", "legacy-token");

    await fetchMe();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({
        credentials: "include",
        headers: expect.not.objectContaining({ Authorization: expect.anything() })
      })
    );
  });

  it("supports 204 logout responses and credentialed CSV downloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 204 })
      .mockResolvedValueOnce({ blob: async () => new Blob(["calls"]), ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await logout();
    await downloadCallHistoryCsv();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/logout",
      expect.objectContaining({ credentials: "include", method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/calls/export.csv",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("encodes admin audit filters without exposing session credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ page: 2, pageSize: 25, total: 0, items: [] }),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchAdminAudit({ page: 2, method: "PATCH", actorId: "11111111-1111-4111-8111-111111111111" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/audit-events?page=2&method=PATCH&actorId=11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("encodes pagination and search for every admin library", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ items: [], imports: [], page: 2, pageSize: 25, total: 0, totalPages: 0 }),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);
    const filters = { q: "summer sales", page: 2, pageSize: 25 };

    await fetchAdminCampaigns(filters);
    await fetchAdminRecordings(filters);
    await fetchAdminUsers(filters);
    await fetchCsvImports(filters);

    for (const [index, library] of ["campaigns", "recordings", "users", "csv-imports"].entries()) {
      expect(fetchMock).toHaveBeenNthCalledWith(
        index + 1,
        `/api/admin/${library}?q=summer+sales&page=2&pageSize=25`,
        expect.objectContaining({ credentials: "include" })
      );
    }
  });

  it("encodes contact and CSV failure pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({}),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchCampaignContacts("campaign-1", {
      q: "alex smith",
      status: "ready",
      page: 2,
      pageSize: 50
    });
    await fetchCsvImportDetail("import-1", { failurePage: 3, failurePageSize: 25 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/campaigns/campaign-1/contacts?q=alex+smith&status=ready&page=2&pageSize=50",
      expect.objectContaining({ credentials: "include" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/csv-imports/import-1?failurePage=3&failurePageSize=25",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("saves an AVMD review with an idempotent call-scoped PUT", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        actualParty: "machine",
        notes: "Clear greeting",
        reviewedByName: "Admin",
        reviewedAt: "2026-07-15T12:00:00.000Z",
        updatedAt: "2026-07-15T12:00:00.000Z"
      }),
      ok: true,
      status: 200
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertCallAvmdReview("call/id", { actualParty: "machine", notes: "Clear greeting" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/calls/call%2Fid/avmd-review",
      expect.objectContaining({
        body: JSON.stringify({ actualParty: "machine", notes: "Clear greeting" }),
        credentials: "include",
        method: "PUT"
      })
    );
  });
});

describe("agent live-event subscription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses credentialed EventSource, forwards refresh events and closes cleanly", () => {
    const listeners = new Map<string, EventListener>();
    const close = vi.fn();
    const constructor = vi.fn().mockImplementation(function FakeEventSource(
      this: { addEventListener: (type: string, listener: EventListener) => void; close: () => void },
      _url: string,
      _options: EventSourceInit
    ) {
      this.addEventListener = (type, listener) => listeners.set(type, listener);
      this.close = close;
    });
    vi.stubGlobal("EventSource", constructor);
    const onRefresh = vi.fn();

    const unsubscribe = subscribeAgentEvents({ onRefresh });
    listeners.get("refresh")?.(
      new MessageEvent("refresh", {
        data: JSON.stringify({ source: "calls", occurredAt: "2026-07-17T10:00:00.000Z" })
      })
    );
    unsubscribe();

    expect(constructor).toHaveBeenCalledWith("/api/agent/events", { withCredentials: true });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith({ source: "calls", occurredAt: "2026-07-17T10:00:00.000Z" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
