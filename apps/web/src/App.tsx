import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Ban,
  BarChart3,
  FileAudio,
  Headphones,
  History,
  Radio,
  Settings2,
  Shield,
  Upload
} from "lucide-react";
import {
  fetchAgentDesk,
  fetchAdminOverview,
  fetchCsvImports,
  fetchMe,
  isApiError,
  login,
  logout,
  subscribeAgentEvents
} from "./api";
import type { AgentLiveRefreshEvent } from "./api";
import { AgentDesk } from "./features/agent-desk/agent-desk";
import { AnalyticsView } from "./features/analytics/analytics-view";
import { Campaigns } from "./features/campaigns/campaigns-view";
import { HistoryView } from "./features/history/history-view";
import { LiveCallsView } from "./features/live-calls/live-calls-view";
import { Recordings } from "./features/recordings/recordings-view";
import { SettingsView } from "./features/settings/settings-view";
import { LoginScreen, TopBar } from "./features/shell/app-shell";
import { SuppressionView } from "./features/suppression/suppression-view";
import { getErrorMessage } from "./lib/errors";
import { useSoftphoneRegistration } from "./softphone";
import { useSupervisorSoftphone } from "./supervisor-softphone";
import type { SupervisorSoftphoneRuntime } from "./supervisor-softphone";
import type { AdminOverviewResponse, AgentDeskResponse, CsvImportSummary, PublicUser } from "./types";

export { formatCallLifecycleStatus } from "./features/history/history-view";

type View =
  "desk" | "live" | "analytics" | "campaigns" | "recordings" | "history" | "suppression" | "settings";
const selectedCampaignStorageKey = "outbound_dialer_selected_campaign_id";

const viewPaths: Record<View, string> = {
  desk: "/",
  live: "/live-calls",
  analytics: "/analytics",
  campaigns: "/campaigns",
  recordings: "/recordings",
  history: "/call-history",
  suppression: "/suppression",
  settings: "/settings"
};

function readNavigationState(): { campaignId: string | null; view: View } {
  const normalizedPath = window.location.pathname.replace(/\/$/, "") || "/";
  const view =
    (Object.entries(viewPaths).find(([, path]) => path === normalizedPath)?.[0] as View | undefined) ??
    "desk";
  return {
    campaignId: new URLSearchParams(window.location.search).get("campaignId") ?? readStoredCampaignId(),
    view
  };
}

function readStoredCampaignId(): string | null {
  try {
    return window.localStorage.getItem(selectedCampaignStorageKey);
  } catch {
    return null;
  }
}

function storeSelectedCampaignId(campaignId: string | null) {
  try {
    if (campaignId) {
      window.localStorage.setItem(selectedCampaignStorageKey, campaignId);
    } else {
      window.localStorage.removeItem(selectedCampaignStorageKey);
    }
  } catch {
    // URL persistence remains available when browser storage is disabled.
  }
}

function writeNavigationState(view: View, campaignId: string | null, replace = false) {
  const url = new URL(window.location.href);
  url.pathname = viewPaths[view];
  if (campaignId) {
    url.searchParams.set("campaignId", campaignId);
  } else {
    url.searchParams.delete("campaignId");
  }
  storeSelectedCampaignId(campaignId);
  window.history[replace ? "replaceState" : "pushState"]({}, "", `${url.pathname}${url.search}${url.hash}`);
}

const navItems: Array<{ id: View; label: string; icon: typeof BarChart3 }> = [
  { id: "desk", label: "Agent desk", icon: BarChart3 },
  { id: "live", label: "Live calls", icon: Headphones },
  { id: "analytics", label: "Analytics", icon: Activity },
  { id: "campaigns", label: "Campaigns", icon: Upload },
  { id: "recordings", label: "Recordings", icon: FileAudio },
  { id: "history", label: "Call history", icon: History },
  { id: "suppression", label: "Suppression", icon: Ban },
  { id: "settings", label: "Settings", icon: Settings2 }
];

const deskRefreshSources = new Set([
  "agents",
  "calls",
  "call_events",
  "campaigns",
  "contacts",
  "recordings",
  "suppression_entries",
  "users"
]);

const adminRefreshSources: Record<Exclude<View, "desk">, ReadonlySet<string>> = {
  live: new Set(["calls", "call_events", "call_supervisor_sessions"]),
  analytics: new Set(["agents", "calls", "call_events", "campaigns", "contacts"]),
  campaigns: new Set(["campaigns", "contacts", "csv_imports", "csv_import_failures"]),
  recordings: new Set(["recordings"]),
  history: new Set(["agents", "calls", "call_events", "call_pcaps", "campaigns"]),
  suppression: new Set(["suppression_entries", "suppression_events"]),
  settings: new Set(["agents", "calls", "call_events", "campaigns", "users"])
};

function sourceAffectsDesk(source: string): boolean {
  return source === "database" || deskRefreshSources.has(source);
}

function sourceAffectsView(source: string, view: Exclude<View, "desk">): boolean {
  return source === "database" || adminRefreshSources[view].has(source);
}

export function App() {
  const initialNavigation = useRef(readNavigationState());
  const [sessionReady, setSessionReady] = useState(false);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [desk, setDesk] = useState<AgentDeskResponse | null>(null);
  const [admin, setAdmin] = useState<AdminOverviewResponse | null>(null);
  const [csvImports, setCsvImports] = useState<CsvImportSummary[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(
    initialNavigation.current.campaignId
  );
  const [view, setView] = useState<View>(initialNavigation.current.view);
  const [error, setError] = useState<string | null>(null);
  const [manualDialNumber, setManualDialNumber] = useState("");
  const [viewRefreshVersion, setViewRefreshVersion] = useState(0);
  const deskRequestRef = useRef(0);
  const deskBackgroundRequestRef = useRef(0);
  const deskActionPendingRef = useRef(false);
  const liveRefreshRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const activeUserIdRef = useRef<string | null>(user?.id ?? null);
  activeUserIdRef.current = user?.id ?? null;
  const isAgentOnly = user?.role === "agent";
  const activeView: View = isAgentOnly ? "desk" : view;

  useEffect(() => {
    window.localStorage.removeItem("outbound_dialer_token");
    void hydrateSession();
  }, []);

  useEffect(() => {
    const restoreNavigation = () => {
      const navigation = readNavigationState();
      if (user && desk?.activeCall && navigation.view !== "desk") {
        const campaignId = selectedCampaignId ?? desk.campaign?.id ?? navigation.campaignId;
        setView("desk");
        setSelectedCampaignId(campaignId);
        writeNavigationState("desk", campaignId, true);
        return;
      }
      setView(navigation.view);
      setSelectedCampaignId(navigation.campaignId);
    };
    window.addEventListener("popstate", restoreNavigation);
    return () => window.removeEventListener("popstate", restoreNavigation);
  }, [desk?.activeCall?.id, desk?.campaign?.id, selectedCampaignId, user?.role]);

  function resetSession(nextError: string | null = null) {
    sessionRequestRef.current += 1;
    deskRequestRef.current += 1;
    deskBackgroundRequestRef.current += 1;
    deskActionPendingRef.current = false;
    liveRefreshRequestRef.current += 1;
    setUser(null);
    setDesk(null);
    setAdmin(null);
    setCsvImports([]);
    const navigation = readNavigationState();
    setSelectedCampaignId(navigation.campaignId);
    setManualDialNumber("");
    setViewRefreshVersion(0);
    setView(navigation.view);
    setError(nextError);
  }

  async function hydrateSession() {
    const sessionRequest = ++sessionRequestRef.current;
    try {
      const [{ user: nextUser }, nextDesk] = await Promise.all([
        fetchMe(),
        fetchAgentDesk(selectedCampaignId ?? undefined)
      ]);
      if (sessionRequest !== sessionRequestRef.current) {
        return;
      }
      deskRequestRef.current += 1;
      deskBackgroundRequestRef.current += 1;
      setUser(nextUser);
      setDesk(nextDesk);
      const nextCampaignId = nextDesk.campaign?.id ?? null;
      const nextView: View = nextUser.role === "agent" || nextDesk.activeCall ? "desk" : view;
      setSelectedCampaignId(nextCampaignId);
      setView(nextView);
      writeNavigationState(nextView, nextCampaignId, true);
      if (nextUser.role === "admin") {
        const [nextAdmin, nextImports] = await Promise.all([fetchAdminOverview(), fetchCsvImports()]);
        if (sessionRequest !== sessionRequestRef.current) {
          return;
        }
        setAdmin(nextAdmin);
        setCsvImports(nextImports.imports);
      }
    } catch (sessionError) {
      if (sessionRequest !== sessionRequestRef.current) {
        return;
      }
      setSessionReady(true);
      resetSession(
        isApiError(sessionError) && sessionError.status === 401
          ? null
          : getErrorMessage(sessionError, "Could not load session")
      );
    } finally {
      if (sessionRequest === sessionRequestRef.current) {
        setSessionReady(true);
      }
    }
  }

  async function handleLogin(email: string, password: string) {
    setError(null);
    sessionRequestRef.current += 1;
    await login(email, password);
    await hydrateSession();
  }

  async function handleLogout() {
    sessionRequestRef.current += 1;
    try {
      await logout();
    } finally {
      resetSession();
    }
  }

  async function handleCampaignChange(campaignId: string) {
    const requestId = ++deskRequestRef.current;
    deskBackgroundRequestRef.current += 1;
    deskActionPendingRef.current = true;
    try {
      const nextDesk = await fetchAgentDesk(campaignId);
      if (requestId !== deskRequestRef.current) {
        return;
      }
      const nextCampaignId = nextDesk.campaign?.id ?? null;
      setSelectedCampaignId(nextCampaignId);
      setDesk(nextDesk);
      writeNavigationState(activeView, nextCampaignId);
    } finally {
      if (requestId === deskRequestRef.current) {
        deskActionPendingRef.current = false;
      }
    }
  }

  function commitDeskMutation(nextDesk: AgentDeskResponse) {
    if (activeUserIdRef.current !== nextDesk.user.id) {
      return;
    }
    deskRequestRef.current += 1;
    setDesk(nextDesk);
    setSelectedCampaignId(nextDesk.campaign?.id ?? null);
  }

  function navigateToView(nextView: View) {
    if (desk?.activeCall && nextView !== "desk") {
      setView("desk");
      writeNavigationState("desk", selectedCampaignId, true);
      return;
    }
    setView(nextView);
    writeNavigationState(nextView, selectedCampaignId);
  }

  useEffect(() => {
    if (!user || !desk?.activeCall) {
      return undefined;
    }

    let stopped = false;
    const refreshDesk = async () => {
      if (deskActionPendingRef.current) return;
      const requestId = ++deskBackgroundRequestRef.current;
      const deskVersion = deskRequestRef.current;
      try {
        const nextDesk = await fetchAgentDesk(selectedCampaignId ?? desk.campaign?.id);
        if (
          stopped ||
          requestId !== deskBackgroundRequestRef.current ||
          deskVersion !== deskRequestRef.current ||
          deskActionPendingRef.current
        ) {
          return;
        }
        setDesk(nextDesk);
        setSelectedCampaignId(nextDesk.campaign?.id ?? null);
      } catch (refreshError) {
        if (
          stopped ||
          requestId !== deskBackgroundRequestRef.current ||
          deskVersion !== deskRequestRef.current
        ) {
          return;
        }
        if (isApiError(refreshError) && refreshError.status === 401) {
          resetSession(getErrorMessage(refreshError, "Session expired"));
          return;
        }
        setError(getErrorMessage(refreshError, "Could not refresh call status"));
      }
    };

    const interval = window.setInterval(() => {
      void refreshDesk();
    }, 2000);

    return () => {
      stopped = true;
      deskBackgroundRequestRef.current += 1;
      window.clearInterval(interval);
    };
  }, [desk?.activeCall?.id, desk?.campaign?.id, selectedCampaignId, user]);

  useEffect(() => {
    if (!user) {
      return undefined;
    }

    let stopped = false;
    let debounce: number | null = null;
    const pendingSources = new Set<string>();
    const refresh = async (sources: ReadonlySet<string>) => {
      const requestId = ++liveRefreshRequestRef.current;
      try {
        const shouldRefreshDesk = [...sources].some(sourceAffectsDesk);
        const canRefreshDesk = shouldRefreshDesk && !deskActionPendingRef.current;
        const deskRequestId = canRefreshDesk
          ? ++deskBackgroundRequestRef.current
          : deskBackgroundRequestRef.current;
        const deskVersion = deskRequestRef.current;
        const nextDesk = canRefreshDesk ? await fetchAgentDesk(selectedCampaignId ?? undefined) : null;
        if (
          nextDesk &&
          !stopped &&
          requestId === liveRefreshRequestRef.current &&
          deskRequestId === deskBackgroundRequestRef.current &&
          deskVersion === deskRequestRef.current &&
          !deskActionPendingRef.current
        ) {
          setDesk(nextDesk);
          setSelectedCampaignId(nextDesk.campaign?.id ?? null);
        }

        if (
          user.role === "admin" &&
          activeView !== "desk" &&
          [...sources].some((source) => sourceAffectsView(source, activeView))
        ) {
          const nextAdmin = await fetchAdminOverview();
          if (stopped || requestId !== liveRefreshRequestRef.current) return;
          setAdmin(nextAdmin);
          setViewRefreshVersion((current) => current + 1);
        }

        if (
          user.role === "admin" &&
          activeView === "campaigns" &&
          [...sources].some((source) => source === "database" || source.startsWith("csv_import"))
        ) {
          const nextImports = await fetchCsvImports();
          if (stopped || requestId !== liveRefreshRequestRef.current) return;
          setCsvImports(nextImports.imports);
        }
      } catch (refreshError) {
        if (stopped || requestId !== liveRefreshRequestRef.current) return;
        if (isApiError(refreshError) && refreshError.status === 401) {
          resetSession("Session expired");
        }
      }
    };
    const scheduleRefresh = (event: AgentLiveRefreshEvent = { source: "database", occurredAt: "" }) => {
      pendingSources.add(event.source || "database");
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        const sources = new Set(pendingSources);
        pendingSources.clear();
        void refresh(sources);
      }, 100);
    };

    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = subscribeAgentEvents({
        onConnectionChange: (connected) => {
          if (!connected) scheduleRefresh();
        },
        onRefresh: scheduleRefresh
      });
    } catch {
      // The periodic refresh below keeps the desk usable if SSE is unavailable.
    }
    const fallback = window.setInterval(() => void refresh(new Set(["database"])), 30_000);

    return () => {
      stopped = true;
      liveRefreshRequestRef.current += 1;
      deskBackgroundRequestRef.current += 1;
      if (debounce !== null) window.clearTimeout(debounce);
      window.clearInterval(fallback);
      unsubscribe();
    };
  }, [activeView, selectedCampaignId, user?.id, user?.role]);
  const softphoneRuntime = useSoftphoneRegistration(user && activeView === "desk" ? user : null);
  const supervisorSoftphone = useSupervisorSoftphone(
    user?.role === "admin" && activeView === "live" ? user : null
  );

  if (!sessionReady) {
    return <div className="boot-screen">Loading dialer</div>;
  }

  if (!user || !desk) {
    return <LoginScreen error={error} onLogin={handleLogin} />;
  }

  return (
    <div className={isAgentOnly ? "app-shell agent-shell" : "app-shell"}>
      {!isAgentOnly && (
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <Radio size={19} />
            </div>
            <div>
              <strong>Dialer</strong>
            </div>
          </div>
          <div className="workspace-label">
            <span>Campaign</span>
            <strong>{desk.campaign?.name ?? "Outbound calling"}</strong>
          </div>
          <nav aria-label="Primary navigation" className="nav-list">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  aria-current={item.id === activeView ? "page" : undefined}
                  aria-label={item.label}
                  className={item.id === activeView ? "nav-item active" : "nav-item"}
                  disabled={Boolean(desk.activeCall && activeView === "desk" && item.id !== "desk")}
                  key={item.id}
                  onClick={() => navigateToView(item.id)}
                  type="button"
                  title={
                    desk.activeCall && activeView === "desk" && item.id !== "desk"
                      ? "Finish the active call first"
                      : item.label
                  }
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            <span>{user.name}</span>
            <strong>
              {activeView === "desk"
                ? desk.availability.status === "paused"
                  ? `● Paused · ${softphoneRuntime.registered ? "Phone connected" : "Phone connecting"}`
                  : softphoneRuntime.registered
                    ? "● Ready · Phone connected"
                    : "● Phone connecting"
                : desk.availability.status === "paused"
                  ? "● Paused"
                  : "● Ready"}
            </strong>
            <small>
              {desk.metrics.todayCalls} calls · {desk.metrics.voicemailsDropped} VM drops
            </small>
          </div>
        </aside>
      )}

      <main className="workspace">
        <TopBar
          desk={desk}
          view={activeView}
          showSoftphoneStatus={activeView === "desk"}
          softphone={softphoneRuntime}
          user={user}
          onLogout={handleLogout}
        />
        <div className="workspace-content">
          {activeView === "desk" && (
            <AgentDesk
              desk={desk}
              manualDialNumber={manualDialNumber}
              onCampaignChange={handleCampaignChange}
              onDeskChanged={commitDeskMutation}
              onManualDialNumberChange={setManualDialNumber}
              softphone={softphoneRuntime}
            />
          )}
          {activeView !== "desk" && (
            <AdminView
              admin={admin}
              csvImports={csvImports}
              onChanged={hydrateSession}
              onManualDial={(phoneNumber) => {
                setManualDialNumber(phoneNumber);
                navigateToView("desk");
              }}
              selectedCampaignId={selectedCampaignId}
              viewRefreshVersion={viewRefreshVersion}
              view={activeView}
              user={user}
              supervisorSoftphone={supervisorSoftphone}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function AdminView({
  admin,
  csvImports,
  onChanged,
  onManualDial,
  selectedCampaignId,
  user,
  view,
  viewRefreshVersion,
  supervisorSoftphone
}: {
  admin: AdminOverviewResponse | null;
  csvImports: CsvImportSummary[];
  onChanged: () => Promise<void>;
  onManualDial: (phoneNumber: string) => void;
  selectedCampaignId: string | null;
  user: PublicUser;
  view: View;
  viewRefreshVersion: number;
  supervisorSoftphone: SupervisorSoftphoneRuntime;
}) {
  if (user.role !== "admin") {
    return (
      <section className="locked-view">
        <Shield size={28} />
        <h2>Admin access required</h2>
      </section>
    );
  }

  if (!admin) {
    return <div className="boot-screen inline">Loading operations</div>;
  }

  const content = {
    live: <LiveCallsView refreshVersion={viewRefreshVersion} softphone={supervisorSoftphone} />,
    analytics: <AnalyticsView admin={admin} refreshVersion={viewRefreshVersion} />,
    campaigns: (
      <Campaigns
        admin={admin}
        csvImports={csvImports}
        onChanged={onChanged}
        onManualDial={onManualDial}
        selectedCampaignId={selectedCampaignId}
      />
    ),
    recordings: <Recordings admin={admin} onChanged={onChanged} />,
    history: <HistoryView admin={admin} refreshVersion={viewRefreshVersion} />,
    suppression: <SuppressionView admin={admin} onChanged={onChanged} />,
    settings: <SettingsView admin={admin} onChanged={onChanged} />,
    desk: null
  }[view];

  return <section className="operations-view">{content}</section>;
}
