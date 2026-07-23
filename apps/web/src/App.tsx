import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  BarChart3,
  CheckCircle2,
  Clock3,
  Download,
  FileAudio,
  Headphones,
  History,
  LogOut,
  Mic,
  Pencil,
  Phone,
  PhoneCall,
  PhoneForwarded,
  PhoneOff,
  Play,
  Radio,
  Search,
  Settings2,
  Shield,
  Trash2,
  Upload,
  UserCheck,
  UserPlus,
  UserX,
  Users,
  Voicemail,
  XCircle
} from "lucide-react";
import {
  isApiError,
  createSuppression,
  createUser,
  deleteSuppression,
  dropVoicemail,
  endCall,
  fetchAdminOverview,
  fetchAdminAudit,
  fetchAdminUsers,
  fetchCallDetail,
  fetchCallHistory,
  fetchCsvImports,
  fetchAgentDesk,
  fetchFreeSwitchDiagnostics,
  fetchSystemSettings,
  fetchSuppression,
  fetchMe,
  getCallRecordingAudioUrl,
  downloadCallHistoryCsv,
  downloadCallPcap,
  importSuppressionCsvFile,
  login,
  logout,
  runFreeSwitchSafeTest,
  sendDtmf,
  startLeadCall,
  startManualCall,
  startNextCall,
  subscribeAgentEvents,
  updateAgentAvailability,
  updateUser,
  updateSystemSettings,
  upsertCallAvmdReview
} from "./api";
import type { AgentLiveRefreshEvent } from "./api";
import { AdminLibraryPagination } from "./components/admin-library-pagination";
import { Metric, PanelHeader, StatusBadge } from "./components/ui-primitives";
import { AnalyticsView } from "./features/analytics/analytics-view";
import { AudioSetupPanel } from "./features/audio/audio-setup-panel";
import { Campaigns } from "./features/campaigns/campaigns-view";
import { LiveCallsView } from "./features/live-calls/live-calls-view";
import { Recordings } from "./features/recordings/recordings-view";
import { getErrorMessage } from "./lib/errors";
import {
  formatBytes,
  formatBrowserMilliseconds,
  formatDateTime,
  formatDuration,
  formatMilliseconds,
  formatNullablePercent,
  formatPercent
} from "./lib/formatters";
import { getDisplayCompany } from "./lib/lead-formatters";
import { useSoftphoneRegistration } from "./softphone";
import type { SoftphoneRuntime } from "./softphone";
import { useSupervisorSoftphone } from "./supervisor-softphone";
import type { SupervisorSoftphoneRuntime } from "./supervisor-softphone";
import type {
  AdminOverviewResponse,
  AdminAuditResponse,
  AdminUserListResponse,
  AdminSystemSettings,
  UpdateAdminSystemSettingsRequest,
  AgentDeskResponse,
  CallAvmdReview,
  CsvImportSummary,
  CallDetailResponse,
  BrowserMediaTelemetry,
  CallMediaQuality,
  CallHistoryResponse,
  FreeSwitchDiagnosticsResponse,
  FreeSwitchSafeTestResponse,
  LeadSummary,
  PublicUser,
  SuppressionListResponse
} from "./types";

type View =
  "desk" | "live" | "analytics" | "campaigns" | "recordings" | "history" | "suppression" | "settings";
type AgentDeskWithCampaign = AgentDeskResponse & { campaign: NonNullable<AgentDeskResponse["campaign"]> };
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

function getPhoneStatusCopy(softphone: SoftphoneRuntime): { detail: string; label: string } {
  if (softphone.registered) {
    return { label: "Phone ready", detail: "Calls will connect in this browser." };
  }
  if (!softphone.microphoneAllowed) {
    return {
      label: "Microphone access needed",
      detail: "Allow microphone access in your browser, then reload this page."
    };
  }
  if (softphone.state === "requesting_microphone" || softphone.state === "registering") {
    return { label: "Connecting phone", detail: "This usually takes a few seconds." };
  }
  return {
    label: "Phone unavailable",
    detail: "Reload the page. If it stays offline, contact an administrator."
  };
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

function LoginScreen({
  error,
  onLogin
}: {
  error: string | null;
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    document.title = "Sign in · Dialer";
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFormError(null);
    try {
      await onLogin(email, password);
    } catch (loginError) {
      setFormError(loginError instanceof Error ? loginError.message : "Login failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand login-brand">
          <div className="brand-mark">
            <Radio size={19} />
          </div>
          <div>
            <strong>Dialer</strong>
            <span>Outbound calling workspace</span>
          </div>
        </div>
        <form onSubmit={submit}>
          <label>
            Email
            <input
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          {(formError || error) && (
            <p className="form-error" role="alert">
              {formError ?? error}
            </p>
          )}
          <button className="primary-action" disabled={pending} type="submit">
            <PhoneCall size={17} />
            {pending ? "Signing in" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function TopBar({
  desk,
  onLogout,
  showSoftphoneStatus,
  softphone,
  user,
  view
}: {
  desk: AgentDeskResponse;
  onLogout: () => void;
  showSoftphoneStatus: boolean;
  softphone: SoftphoneRuntime;
  user: PublicUser;
  view: View;
}) {
  const titles: Record<View, { title: string; subtitle: string }> = {
    desk: {
      title: "Agent desk",
      subtitle: desk.campaign
        ? `${desk.campaign.name} / ${desk.campaign.callableLeads} callable leads`
        : "No active campaign"
    },
    analytics: { title: "Analytics", subtitle: "Campaign, agent and call performance" },
    live: { title: "Live calls", subtitle: "Listen, coach or join an active conversation" },
    campaigns: { title: "Campaigns", subtitle: "Lead queues, imports and campaign controls" },
    recordings: { title: "Voicemail recordings", subtitle: "Approved audio used by agent handoffs" },
    history: { title: "Call history", subtitle: "Outcomes and recorded conversations" },
    suppression: { title: "Suppression", subtitle: "Numbers excluded from outbound calling" },
    settings: { title: "Settings", subtitle: "Users, calling controls and operations" }
  };
  const heading = titles[view];
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${heading.title} · Dialer`;
    headingRef.current?.focus();
  }, [heading.title]);
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1 ref={headingRef} tabIndex={-1}>
          {heading.title}
        </h1>
        <p>{heading.subtitle}</p>
      </div>
      <div className="topbar-actions">
        {showSoftphoneStatus && (
          <>
            <StatusBadge
              label={softphone.registered ? "● Phone connected" : "● Phone offline"}
              tone={softphone.registered ? "good" : "bad"}
            />
            <StatusBadge
              label={softphone.microphoneAllowed ? "● Mic allowed" : "● Mic blocked"}
              tone={softphone.microphoneAllowed ? "good" : "bad"}
            />
          </>
        )}
        <div className="user-pill">
          <Headphones size={16} />
          <span>{user.name}</span>
        </div>
        <button aria-label="Log out" className="icon-button" onClick={onLogout} title="Log out" type="button">
          <LogOut size={17} />
        </button>
      </div>
    </header>
  );
}

function AgentDesk({
  desk,
  manualDialNumber,
  onCampaignChange,
  onDeskChanged,
  onManualDialNumberChange,
  softphone
}: {
  desk: AgentDeskResponse;
  manualDialNumber: string;
  onCampaignChange: (campaignId: string) => Promise<void>;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onManualDialNumberChange: (phoneNumber: string) => void;
  softphone: SoftphoneRuntime;
}) {
  const [callNextPending, setCallNextPending] = useState(false);
  const callStartPendingRef = useRef(false);
  const [callNextError, setCallNextError] = useState<string | null>(null);
  const [callControlPending, setCallControlPending] = useState<"hangup" | "voicemail" | "dtmf" | null>(null);
  const callControlPendingRef = useRef<typeof callControlPending>(null);
  const [endCallError, setEndCallError] = useState<string | null>(null);
  const previousActiveCallRef = useRef(
    desk.activeCall
      ? {
          id: desk.activeCall.id,
          manualDial: desk.activeCall.manualDial ?? desk.activeCall.leadName === "Manual dial"
        }
      : null
  );
  const campaign = desk.campaign;
  const availabilityStatus = useEffectiveAvailability(desk.availability);
  const autoAdvancePausedRef = useRef(availabilityStatus === "paused");
  const canStartCalls =
    softphone.registered && availabilityStatus === "available" && !softphone.audioSetup.checking;

  useEffect(() => {
    autoAdvancePausedRef.current = availabilityStatus === "paused";
  }, [availabilityStatus]);

  function handleAvailabilityChangeStarted(status: "available" | "paused") {
    autoAdvancePausedRef.current = status === "paused";
  }

  function handleAvailabilityChangeFailed() {
    autoAdvancePausedRef.current = availabilityStatus === "paused";
  }

  async function callNext() {
    if (!campaign) {
      setCallNextError("No active campaign is available");
      return;
    }
    if (!canStartCalls) {
      setCallNextError(callStartBlockedMessage(desk, softphone));
      return;
    }
    setCallNextError(null);
    try {
      await runCallStart(() => startNextCall({ campaignId: campaign.id }));
    } catch (error) {
      setCallNextError(error instanceof Error ? error.message : "Could not start next call");
    }
  }

  async function callLead(lead: LeadSummary) {
    if (!canStartCalls) {
      setCallNextError(callStartBlockedMessage(desk, softphone));
      return;
    }
    const confirmCompletedLead = lead.status === "completed";
    const confirmRetryWait = lead.status === "retry_wait";
    if (
      confirmCompletedLead &&
      !window.confirm("This lead has already been called. Are you sure you want to call them again?")
    ) {
      return;
    }
    if (
      confirmRetryWait &&
      !window.confirm("This lead is still in the retry timeout. Are you sure you want to call them now?")
    ) {
      return;
    }
    setCallNextError(null);
    try {
      await runCallStart(() => startLeadCall(lead.id, { confirmCompletedLead, confirmRetryWait }));
    } catch (error) {
      setCallNextError(error instanceof Error ? error.message : "Could not start lead call");
    }
  }

  async function callManual(phoneNumber: string) {
    if (!campaign) {
      throw new Error("No active campaign is available");
    }
    await runCallStart(() => startManualCall({ campaignId: campaign.id, phoneNumber }));
  }

  async function runCallStart(action: () => Promise<AgentDeskResponse>) {
    if (callStartPendingRef.current) {
      throw new Error("Another call is already starting");
    }
    callStartPendingRef.current = true;
    setCallNextPending(true);
    try {
      onDeskChanged(await action());
    } finally {
      callStartPendingRef.current = false;
      setCallNextPending(false);
    }
  }

  useEffect(() => {
    const previousActiveCall = previousActiveCallRef.current;
    previousActiveCallRef.current = desk.activeCall
      ? {
          id: desk.activeCall.id,
          manualDial: desk.activeCall.manualDial ?? desk.activeCall.leadName === "Manual dial"
        }
      : null;
    if (
      !previousActiveCall ||
      previousActiveCall.manualDial ||
      desk.activeCall ||
      !campaign?.autoAdvanceToNextLeadEnabled ||
      campaign.callableLeads <= 0 ||
      autoAdvancePausedRef.current ||
      !canStartCalls
    ) {
      return;
    }
    void callNext();
  }, [desk.activeCall?.id]);

  async function hangUp(callId: string) {
    await runCallControl("hangup", () => endCall(callId, { campaignId: campaign?.id }), "Could not end call");
  }

  async function handleDropVoicemail(callId: string, recordingId?: string) {
    await runCallControl(
      "voicemail",
      () => dropVoicemail(callId, { campaignId: campaign?.id, recordingId }),
      "Could not drop voicemail"
    );
  }

  async function handleSendDtmf(callId: string, digit: string) {
    await runCallControl(
      "dtmf",
      () => sendDtmf(callId, { campaignId: campaign?.id, digit }),
      "Could not send DTMF"
    );
  }

  async function runCallControl(
    kind: NonNullable<typeof callControlPending>,
    action: () => Promise<AgentDeskResponse>,
    fallbackError: string
  ) {
    if (callControlPendingRef.current) {
      return;
    }
    callControlPendingRef.current = kind;
    setCallControlPending(kind);
    setEndCallError(null);
    try {
      onDeskChanged(await action());
    } catch (error) {
      setEndCallError(error instanceof Error ? error.message : fallbackError);
    } finally {
      callControlPendingRef.current = null;
      setCallControlPending(null);
    }
  }

  if (!campaign) {
    return (
      <section className={desk.activeCall ? "agent-grid active-agent-grid" : "ready-desk-grid"}>
        <NoCampaignPanel />
        {desk.activeCall && (
          <ActiveCall
            desk={desk}
            controlPending={callControlPending}
            error={endCallError}
            onDropVoicemail={handleDropVoicemail}
            onHangUp={hangUp}
            onSendDtmf={handleSendDtmf}
            onAvailabilityChangeFailed={handleAvailabilityChangeFailed}
            onAvailabilityChangeStarted={handleAvailabilityChangeStarted}
            onDeskChanged={onDeskChanged}
            softphone={softphone}
          />
        )}
        <AgentNoCampaignStatus desk={desk} onDeskChanged={onDeskChanged} softphone={softphone} />
        <VoicemailJobs jobs={desk.voicemailJobs} />
        <RecentAgentCalls calls={desk.recentCalls} />
      </section>
    );
  }

  const campaignDesk = desk as AgentDeskWithCampaign;

  if (desk.activeCall) {
    const activeLead = desk.leads.find(
      (lead) => lead.status === "calling" || lead.phoneNumber === desk.activeCall?.phoneNumber
    );
    return (
      <section className="agent-grid active-agent-grid">
        <LeadQueue
          canStartCalls={canStartCalls}
          error={callNextError}
          leads={desk.leads}
          onCallLead={callLead}
          onCallNext={callNext}
          pending={callNextPending}
          showRecommendedCall={false}
        />
        <ActiveCall
          desk={desk}
          controlPending={callControlPending}
          error={endCallError}
          onDropVoicemail={handleDropVoicemail}
          onHangUp={hangUp}
          onSendDtmf={handleSendDtmf}
          onAvailabilityChangeFailed={handleAvailabilityChangeFailed}
          onAvailabilityChangeStarted={handleAvailabilityChangeStarted}
          onDeskChanged={onDeskChanged}
          softphone={softphone}
        />
        <LeadContextPanel lead={activeLead} />
        <VoicemailJobs jobs={desk.voicemailJobs} />
      </section>
    );
  }

  return (
    <section className="ready-desk-grid">
      <LeadQueue
        canStartCalls={canStartCalls}
        error={callNextError}
        leads={desk.leads}
        onCallLead={callLead}
        onCallNext={callNext}
        pending={callNextPending}
      />
      <AgentStatusPanel
        canStartCalls={canStartCalls}
        callStartPending={callNextPending}
        desk={campaignDesk}
        manualDialNumber={manualDialNumber}
        mode="ready"
        onCampaignChange={onCampaignChange}
        onAvailabilityChangeFailed={handleAvailabilityChangeFailed}
        onAvailabilityChangeStarted={handleAvailabilityChangeStarted}
        onDeskChanged={onDeskChanged}
        onManualDialNumberChange={onManualDialNumberChange}
        onStartManualCall={callManual}
        softphone={softphone}
      />
      <VoicemailJobs jobs={desk.voicemailJobs} />
      <RecentAgentCalls calls={desk.recentCalls} />
    </section>
  );
}

function VoicemailJobs({ jobs }: { jobs: AgentDeskResponse["voicemailJobs"] }) {
  if (!jobs.length) {
    return null;
  }
  return (
    <article className="panel background-jobs" aria-live="polite">
      <PanelHeader icon={Voicemail} title="Voicemail jobs" meta={`${jobs.length} recent`} />
      <div className="table-list">
        {jobs.map((job) => (
          <div className="table-row background-job-row" key={job.callId}>
            <span>
              <strong>{job.leadName}</strong>
              <small>{job.phoneNumber}</small>
            </span>
            <StatusBadge
              label={job.status === "playing" ? "Playing" : job.status}
              tone={job.status === "completed" ? "good" : job.status === "interrupted" ? "bad" : "warn"}
            />
          </div>
        ))}
      </div>
    </article>
  );
}

function RecentAgentCalls({ calls }: { calls: AgentDeskResponse["recentCalls"] }) {
  if (!calls.length) {
    return null;
  }
  return (
    <article className="panel recent-agent-calls">
      <PanelHeader icon={History} title="Recent calls" meta={`${calls.length} calls`} />
      <div className="table-list">
        {calls.map((call) => (
          <div className="table-row recent-call-row" key={call.id}>
            <span>
              <strong>{call.leadName}</strong>
              <small>{call.phoneNumber}</small>
            </span>
            <b className={`outcome-badge outcome-${call.outcome ?? call.state}`}>
              {formatCallLifecycleStatus(call.state, call.outcome)}
            </b>
          </div>
        ))}
      </div>
    </article>
  );
}

function NoCampaignPanel() {
  return (
    <article className="panel no-campaign-panel">
      <PanelHeader icon={AlertTriangle} title="No active campaign" meta="Setup" />
      <div className="empty-queue-state large-empty-state">
        <strong>No active campaign is available</strong>
        <p>Create or activate a campaign, then import leads.</p>
      </div>
    </article>
  );
}

function LeadQueue({
  canStartCalls,
  error,
  leads,
  onCallLead,
  onCallNext,
  pending,
  showRecommendedCall = true
}: {
  canStartCalls: boolean;
  error: string | null;
  leads: LeadSummary[];
  onCallLead: (lead: LeadSummary) => Promise<void>;
  onCallNext: () => Promise<void>;
  pending: boolean;
  showRecommendedCall?: boolean;
}) {
  const [query, setQuery] = useState("");
  const recommended = leads.find((lead) => lead.status === "ready");
  const visibleLeads = leads.filter((lead) =>
    `${lead.name} ${getDisplayCompany(lead.company)} ${lead.phoneNumber}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  );
  const activeQueue = !showRecommendedCall;

  return (
    <article className="panel lead-queue next-leads-panel">
      <div className="surface-heading">
        <div className="heading-with-count">
          <h2>{activeQueue ? "Lead queue" : "Next leads"}</h2>
          <span>{leads.length}</span>
        </div>
        <p>{activeQueue ? "Current campaign queue" : "Start the next call from the campaign queue."}</p>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {showRecommendedCall && recommended && (
        <div className="recommended-call">
          <h3>Next lead</h3>
          <p>
            {recommended.name}, {recommended.phoneNumber}
          </p>
          <button
            className="primary-action teal-action"
            disabled={pending || !canStartCalls}
            onClick={onCallNext}
            type="button"
          >
            <PhoneCall size={17} />
            {pending ? "Starting" : "Start next call"}
          </button>
        </div>
      )}
      {showRecommendedCall && !recommended && (
        <p className="empty-state">
          No contacts are callable yet. Retries become available after the configured cooldown.
        </p>
      )}
      <label className="queue-search">
        <Search size={15} />
        <input
          aria-label="Search leads"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name or phone"
          value={query}
        />
      </label>
      <div className="lead-table" role="table" aria-label={activeQueue ? "Lead queue" : "Next leads"}>
        <div className="lead-table-row lead-table-head" role="row">
          <span aria-hidden="true" />
          <span role="columnheader">Lead</span>
          <span role="columnheader">Status</span>
        </div>
        {visibleLeads.map((lead) => {
          const company = getDisplayCompany(lead.company);
          return (
            <div className={`lead-table-row lead-${lead.status}`} key={lead.id} role="row">
              <span className="lead-avatar" aria-hidden="true">
                {getInitials(lead.name)}
              </span>
              <div className="lead-identity" role="cell">
                <strong>{lead.name}</strong>
                {activeQueue && company && <small>{company}</small>}
                <span>{lead.phoneNumber}</span>
              </div>
              <div className="lead-row-state" role="cell">
                <b>{formatLeadStatus(lead)}</b>
                {showRecommendedCall && (
                  <button
                    className="pill-action"
                    disabled={
                      pending || !["ready", "retry_wait", "completed"].includes(lead.status) || !canStartCalls
                    }
                    onClick={() => onCallLead(lead)}
                    type="button"
                  >
                    Call
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!visibleLeads.length && (
          <div className="lead-table-empty" role="row">
            <span role="cell">
              {leads.length ? "No leads match your search." : "No leads are queued for this campaign."}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

function getInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?"
  );
}

function LeadContextPanel({ lead }: { lead?: LeadSummary }) {
  const company = getDisplayCompany(lead?.company);
  const visibleFields =
    lead?.fields
      .filter(({ label }) => !["company", "name", "phone"].includes(label.toLowerCase()))
      .slice(0, 5) ?? [];

  return (
    <article className="panel lead-context-panel">
      <div className="surface-heading">
        <h2>Lead context</h2>
        <p>Visible throughout the call</p>
      </div>
      {company && (
        <div className="company-card">
          <span>Company</span>
          <strong>{company}</strong>
          <small>Campaign lead</small>
        </div>
      )}
      <div className="lead-facts">
        {visibleFields.map((field) => (
          <div key={field.label}>
            <span>{field.label}</span>
            <strong>{field.value}</strong>
          </div>
        ))}
        {!visibleFields.length && (
          <div>
            <span>Phone</span>
            <strong>{lead?.phoneNumber ?? "Not available"}</strong>
          </div>
        )}
      </div>
      <div className="compliance-card">
        {lead?.status === "ready" ? <CheckCircle2 size={15} /> : <Clock3 size={15} />}
        <span>{lead ? leadAvailabilityCopy(lead.status) : "Select a lead"}</span>
      </div>
    </article>
  );
}

function formatLeadStatus(lead: LeadSummary): string {
  const labels: Record<LeadSummary["status"], string> = {
    calling: "Connected",
    completed: "Completed",
    exhausted: "Attempt limit reached",
    ready: "Ready",
    retry_wait: lead.lastCallState
      ? formatCallLifecycleStatus(lead.lastCallState, lead.lastCallOutcome ?? null)
      : "No answer",
    suppressed: "Suppressed"
  };
  return labels[lead.status];
}

function leadAvailabilityCopy(status: LeadSummary["status"]): string {
  if (status === "ready") return "Callable · suppression check passed";
  if (status === "retry_wait") return "Retry cooldown is active";
  if (status === "exhausted") return "Configured attempt limit reached";
  if (status === "suppressed") return "Calling blocked by suppression";
  if (status === "completed") return "Contact lifecycle completed";
  return "Call in progress";
}

function useEffectiveAvailability(
  availability: AgentDeskResponse["availability"]
): AgentDeskResponse["availability"]["status"] {
  return availability.status === "wrap_up" ? "available" : availability.status;
}

function callStartBlockedMessage(desk: AgentDeskResponse, softphone: SoftphoneRuntime): string {
  if (softphone.audioSetup.checking) {
    return "Wait for the audio and network check to finish";
  }
  if (!softphone.registered) {
    return "The browser phone is not ready yet";
  }
  if (desk.availability.status === "paused") {
    return "Resume calling before starting a call";
  }
  return "Calling is not available yet";
}

function AvailabilityControl({
  desk,
  disabled = false,
  onAvailabilityChangeFailed,
  onAvailabilityChangeStarted,
  onDeskChanged
}: {
  desk: AgentDeskResponse;
  disabled?: boolean;
  onAvailabilityChangeFailed?: () => void;
  onAvailabilityChangeStarted?: (status: "available" | "paused") => void;
  onDeskChanged: (desk: AgentDeskResponse) => void;
}) {
  const status = useEffectiveAvailability(desk.availability);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paused = status === "paused";
  const statusLabel = paused ? "Paused" : "Ready";
  const actionLabel = paused ? "Resume calling" : "Pause";

  async function toggleAvailability() {
    const nextStatus = status === "available" ? "paused" : "available";
    setPending(true);
    setError(null);
    onAvailabilityChangeStarted?.(nextStatus);
    try {
      onDeskChanged(
        await updateAgentAvailability({
          status: nextStatus,
          campaignId: desk.campaign?.id
        })
      );
    } catch (updateError) {
      onAvailabilityChangeFailed?.();
      setError(updateError instanceof Error ? updateError.message : "Could not change availability");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="availability-control">
      <StatusBadge label={statusLabel} tone={status === "available" ? "good" : "neutral"} />
      <button
        className="pill-action"
        disabled={disabled || pending}
        onClick={() => void toggleAvailability()}
        type="button"
      >
        {pending ? "Saving" : actionLabel}
      </button>
      {error && (
        <small className="form-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

function AgentStatusPanel({
  canStartCalls,
  callStartPending,
  desk,
  manualDialNumber,
  mode,
  onCampaignChange,
  onAvailabilityChangeFailed,
  onAvailabilityChangeStarted,
  onDeskChanged,
  onManualDialNumberChange,
  onStartManualCall,
  softphone
}: {
  canStartCalls: boolean;
  callStartPending: boolean;
  desk: AgentDeskWithCampaign;
  manualDialNumber: string;
  mode: "ready" | "active";
  onCampaignChange: (campaignId: string) => Promise<void>;
  onAvailabilityChangeFailed?: () => void;
  onAvailabilityChangeStarted?: (status: "available" | "paused") => void;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onManualDialNumberChange: (phoneNumber: string) => void;
  onStartManualCall: (phoneNumber: string) => Promise<void>;
  softphone: SoftphoneRuntime;
}) {
  const [campaignPending, setCampaignPending] = useState(false);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [manualDialError, setManualDialError] = useState<string | null>(null);
  const phoneStatus = getPhoneStatusCopy(softphone);

  async function changeCampaign(campaignId: string) {
    setCampaignPending(true);
    setCampaignError(null);
    try {
      await onCampaignChange(campaignId);
    } catch (error) {
      setCampaignError(error instanceof Error ? error.message : "Could not switch campaign");
    } finally {
      setCampaignPending(false);
    }
  }

  async function startManualDial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStartCalls) {
      setManualDialError(callStartBlockedMessage(desk, softphone));
      return;
    }

    setManualDialError(null);
    try {
      await onStartManualCall(manualDialNumber);
      onManualDialNumberChange("");
    } catch (error) {
      setManualDialError(error instanceof Error ? error.message : "Could not start call");
    }
  }

  return (
    <article className="panel agent-status-panel">
      <div className="surface-heading">
        <h2>Agent status</h2>
      </div>
      <label className="campaign-selector">
        Campaign
        <select
          disabled={
            campaignPending || callStartPending || mode === "active" || desk.availableCampaigns.length <= 1
          }
          onChange={(event) => void changeCampaign(event.target.value)}
          value={desk.campaign.id}
        >
          {desk.availableCampaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name} ({campaign.callableLeads})
            </option>
          ))}
        </select>
      </label>
      {campaignError && (
        <p className="form-error" role="alert">
          {campaignError}
        </p>
      )}
      <div className="status-stack">
        <AvailabilityControl
          desk={desk}
          disabled={callStartPending || mode === "active"}
          onAvailabilityChangeFailed={onAvailabilityChangeFailed}
          onAvailabilityChangeStarted={onAvailabilityChangeStarted}
          onDeskChanged={onDeskChanged}
        />
      </div>
      <div className="softphone-runtime-card">
        <div className="softphone-runtime-icon">
          <Mic size={17} />
        </div>
        <div>
          <strong>{phoneStatus.label}</strong>
          <span>{phoneStatus.detail}</span>
        </div>
      </div>
      <div className="softphone-actions">
        {softphone.callState === "active" && (
          <button
            className="danger-action compact-action"
            onClick={() => void softphone.hangUpSoftphoneCall()}
            type="button"
          >
            <PhoneOff size={16} />
            Hang up
          </button>
        )}
      </div>
      <AudioSetupPanel softphone={softphone} />
      {desk.campaign.manualDialingEnabled && (
        <form className="inline-manual-dial" onSubmit={startManualDial}>
          <label htmlFor="manual-dial-number">Manual call</label>
          <div className="inline-manual-dial-controls">
            <input
              autoComplete="tel"
              id="manual-dial-number"
              inputMode="tel"
              onChange={(event) => {
                onManualDialNumberChange(event.target.value);
                setManualDialError(null);
              }}
              placeholder="+1 415 555 0000"
              type="tel"
              value={manualDialNumber}
            />
            <button
              className="primary-action teal-action"
              disabled={callStartPending || !manualDialNumber.trim() || !canStartCalls}
              type="submit"
            >
              <PhoneCall size={17} />
              {callStartPending ? "Starting" : "Call"}
            </button>
          </div>
          {manualDialError && (
            <p className="form-error" role="alert">
              {manualDialError}
            </p>
          )}
        </form>
      )}
      <div className="status-metric-list">
        <Metric label="Callable leads" value={desk.campaign.callableLeads} icon={Users} />
        <Metric label="Calls today" value={desk.metrics.todayCalls} icon={PhoneForwarded} />
        <Metric label="Blocked numbers" value={desk.metrics.suppressed} icon={Ban} />
      </div>
    </article>
  );
}

function AgentNoCampaignStatus({
  desk,
  onDeskChanged,
  softphone
}: {
  desk: AgentDeskResponse;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  softphone: SoftphoneRuntime;
}) {
  const phoneStatus = getPhoneStatusCopy(softphone);
  return (
    <article className="panel agent-status-panel">
      <div className="surface-heading">
        <h2>Agent status</h2>
      </div>
      <div className="status-stack">
        {desk.activeCall ? (
          <StatusBadge label="In call" tone="good" />
        ) : (
          <AvailabilityControl desk={desk} onDeskChanged={onDeskChanged} />
        )}
        <StatusBadge label="Manual dialing unavailable" tone="neutral" />
      </div>
      <div className="softphone-runtime-card">
        <div className="softphone-runtime-icon">
          <Mic size={17} />
        </div>
        <div>
          <strong>{phoneStatus.label}</strong>
          <span>{phoneStatus.detail}</span>
        </div>
      </div>
      <div className="status-metric-list">
        <Metric label="Callable leads" value={0} icon={Users} />
        <Metric label="Calls today" value={desk.metrics.todayCalls} icon={PhoneForwarded} />
        <Metric label="Blocked numbers" value={desk.metrics.suppressed} icon={Ban} />
      </div>
    </article>
  );
}

function ActiveCall({
  controlPending,
  desk,
  error,
  onAvailabilityChangeFailed,
  onAvailabilityChangeStarted,
  onDeskChanged,
  onDropVoicemail,
  onHangUp,
  onSendDtmf,
  softphone
}: {
  controlPending: "hangup" | "voicemail" | "dtmf" | null;
  desk: AgentDeskResponse;
  error: string | null;
  onAvailabilityChangeFailed: () => void;
  onAvailabilityChangeStarted: (status: "available" | "paused") => void;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onDropVoicemail: (callId: string, recordingId?: string) => Promise<void>;
  onHangUp: (callId: string) => Promise<void>;
  onSendDtmf: (callId: string, digit: string) => Promise<void>;
  softphone: SoftphoneRuntime;
}) {
  const activeCall = desk.activeCall as ActiveCallUi | null;
  const displayedDurationSeconds = useActiveCallDuration(activeCall);
  const defaultRecordingId = activeCall?.recordingId ?? desk.recordings[0]?.id ?? "";
  const [selectedRecordingId, setSelectedRecordingId] = useState(defaultRecordingId);
  useEffect(() => {
    setSelectedRecordingId(defaultRecordingId);
  }, [activeCall?.id, defaultRecordingId]);

  if (!activeCall) {
    return (
      <article className="panel active-call">
        <PanelHeader icon={Phone} title="Active call" meta="Ready" />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </article>
    );
  }

  const durationLabel = formatCallLifecycleStatus(activeCall.state, activeCall.outcome ?? null);
  const voicemailSignal = formatVoicemailSignal(activeCall.voicemailSignal);
  const selectedRecording = desk.recordings.find((recording) => recording.id === selectedRecordingId);
  const dropRecordingId = selectedRecording?.id ?? activeCall.recordingId ?? undefined;
  const unavailableAction = {
    allowed: false,
    reason: "Call controls are unavailable. Refresh the Agent Desk before continuing."
  };
  const dropEligibility = activeCall.actions?.dropVoicemail ?? unavailableAction;
  const dtmfEligibility = activeCall.actions?.sendDtmf ?? unavailableAction;
  const browserAudioCopy =
    activeCall.status !== "bridged"
      ? durationLabel
      : softphone.audioPlaybackState === "playing"
        ? "Browser audio playing · customer connected"
        : softphone.audioPlaybackState === "unavailable"
          ? "Browser call audio is unavailable"
          : softphone.audioPlaybackState === "blocked"
            ? "Browser blocked call audio playback"
            : "Customer connected · waiting for browser audio";
  return (
    <article aria-busy={controlPending !== null} className="panel active-call">
      <div className="call-status-line">
        <StatusBadge label={`● ${durationLabel}`} tone="good" />
        <span>Call {activeCall.id.slice(0, 8).toUpperCase()}</span>
      </div>
      {activeCall.supervisor?.active && (
        <div
          className={activeCall.supervisor.mode === "join" ? "supervisor-notice danger" : "supervisor-notice"}
          role="status"
        >
          <Shield size={17} />
          <div>
            <strong>
              {activeCall.supervisor.mode === "join"
                ? "Administrator joined this call"
                : activeCall.supervisor.mode === "whisper"
                  ? "Supervisor coaching is active"
                  : "Administrator is listening"}
            </strong>
            <span>
              {activeCall.supervisor.mode === "join"
                ? "The administrator can speak to you and the customer."
                : activeCall.supervisor.mode === "whisper"
                  ? "You can hear the supervisor; the customer cannot."
                  : "The administrator microphone is off."}
            </span>
          </div>
        </div>
      )}
      <div className="active-call-availability">
        <span>Next call</span>
        <AvailabilityControl
          desk={desk}
          onAvailabilityChangeFailed={onAvailabilityChangeFailed}
          onAvailabilityChangeStarted={onAvailabilityChangeStarted}
          onDeskChanged={onDeskChanged}
        />
      </div>
      <div className="call-hero">
        <div>
          <h2>{activeCall.leadName}</h2>
          <p>{activeCall.phoneNumber}</p>
          {activeCall.campaignName && <small>{activeCall.campaignName}</small>}
        </div>
      </div>
      <div className="call-stage">
        <div className="call-stage-top">
          <span>{softphone.audioPlaybackState === "playing" ? "Live audio" : "Call audio"}</span>
          <strong aria-label={`Call duration ${formatDuration(displayedDurationSeconds)}`}>
            {formatDuration(displayedDurationSeconds)}
          </strong>
        </div>
        <div className="audio-waveform" aria-hidden="true">
          {[
            18, 32, 46, 28, 58, 40, 24, 52, 68, 44, 30, 54, 36, 20, 42, 62, 38, 24, 48, 32, 18, 40, 26, 52,
            34, 20, 44, 30
          ].map((height, index) => (
            <span key={`${height}-${index}`} style={{ height }} />
          ))}
        </div>
        <div className="call-stage-meta">
          <span aria-live="polite">{browserAudioCopy}</span>
          <b className={`recording-state recording-${activeCall.callRecordingStatus}`}>
            {activeCall.callRecordingStatus === "recording"
              ? "● REC"
              : activeCall.callRecordingStatus === "pending"
                ? "REC pending"
                : activeCall.callRecordingStatus === "failed"
                  ? "REC failed"
                  : "Not recorded"}
          </b>
        </div>
        {activeCall.status === "bridged" && softphone.audioPlaybackState === "blocked" && (
          <div className="audio-playback-warning" role="alert">
            <span>Your browser blocked call audio. Start playback to hear the customer.</span>
            <button
              className="secondary-action compact-action"
              onClick={() => void softphone.retryRemoteAudio()}
              type="button"
            >
              <Play size={15} />
              Play call audio
            </button>
          </div>
        )}
        {activeCall.status === "bridged" && softphone.audioPlaybackState === "unavailable" && (
          <div className="audio-playback-warning" role="alert">
            <span>
              The browser could not attach the customer audio stream. End the call and reconnect the phone.
            </span>
          </div>
        )}
      </div>
      <div className="handoff-card">
        <Voicemail size={18} />
        <div>
          <strong>Voicemail reached?</strong>
          <span>Start playback and release the agent leg.</span>
        </div>
      </div>
      <div className="signal-strip">
        <div className={`voicemail-signal ${activeCall.voicemailSignal}`}>
          <span>VM / beep signal</span>
          <strong>{voicemailSignal.label}</strong>
          <small>{voicemailSignal.detail}</small>
        </div>
        <div>
          <span>Recording</span>
          <label className="compact-select">
            <select
              disabled={controlPending !== null || desk.recordings.length === 0}
              onChange={(event) => setSelectedRecordingId(event.target.value)}
              value={selectedRecordingId}
            >
              {desk.recordings.map((recording) => (
                <option key={recording.id} value={recording.id}>
                  {recording.name}
                  {recording.status === "default" ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          {!desk.recordings.length && <strong>No voicemail recordings</strong>}
        </div>
      </div>
      <div className="call-actions call-actions-stacked">
        <button
          className="primary-action voicemail-primary-action"
          disabled={controlPending !== null || !dropRecordingId || !dropEligibility.allowed}
          onClick={() => onDropVoicemail(activeCall.id, dropRecordingId)}
          title={
            !dropEligibility.allowed
              ? (dropEligibility.reason ?? "Voicemail drop is not available yet")
              : undefined
          }
          type="button"
        >
          <Voicemail size={17} />
          {controlPending === "voicemail" ? "Dropping" : "Drop voicemail"}
        </button>
        <button
          className="danger-action"
          disabled={controlPending !== null}
          onClick={() => onHangUp(activeCall.id)}
          type="button"
        >
          <PhoneOff size={17} />
          {controlPending === "hangup" ? "Ending" : "Hang up"}
        </button>
      </div>
      {!dropEligibility.allowed && dropEligibility.reason && (
        <p className="action-hint">{dropEligibility.reason}</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <details className="dtmf-panel">
        <summary>Keypad</summary>
        <div className="dtmf-pad" aria-label="DTMF keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((digit) => (
            <button
              disabled={controlPending !== null || !dtmfEligibility.allowed}
              key={digit}
              onClick={() => void onSendDtmf(activeCall.id, digit)}
              title={
                !dtmfEligibility.allowed ? (dtmfEligibility.reason ?? "DTMF is not available yet") : undefined
              }
              type="button"
            >
              {digit}
            </button>
          ))}
        </div>
      </details>
      {!dtmfEligibility.allowed && dtmfEligibility.reason && (
        <p className="action-hint">{dtmfEligibility.reason}</p>
      )}
      <div className="timeline">
        {activeCall.timeline.map((item) => (
          <div className="timeline-item" key={`${item.at}-${item.label}`}>
            <span>{item.at}</span>
            <p>{item.label}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function useActiveCallDuration(activeCall: ActiveCallUi | null): number {
  const callId = activeCall?.id ?? null;
  const serverDurationSeconds = activeCall?.durationSeconds ?? 0;
  const [durationSeconds, setDurationSeconds] = useState(serverDurationSeconds);
  const clockRef = useRef<{ callId: string; startedAt: number } | null>(null);

  useEffect(() => {
    if (!callId) {
      clockRef.current = null;
      setDurationSeconds(0);
      return;
    }

    const serverStartedAt = Date.now() - serverDurationSeconds * 1000;
    if (clockRef.current?.callId !== callId) {
      clockRef.current = { callId, startedAt: serverStartedAt };
    } else {
      clockRef.current.startedAt = Math.min(clockRef.current.startedAt, serverStartedAt);
    }
    setDurationSeconds(Math.floor((Date.now() - clockRef.current.startedAt) / 1000));
  }, [callId, serverDurationSeconds]);

  useEffect(() => {
    if (!callId) return undefined;
    const interval = window.setInterval(() => {
      const clock = clockRef.current;
      if (clock?.callId === callId) {
        setDurationSeconds(Math.floor((Date.now() - clock.startedAt) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [callId]);

  return callId ? durationSeconds : 0;
}

type ActiveCallUi = NonNullable<AgentDeskResponse["activeCall"]> & { campaignName?: string };

function formatVoicemailSignal(signal: NonNullable<AgentDeskResponse["activeCall"]>["voicemailSignal"]): {
  detail: string;
  label: string;
} {
  if (signal === "detected") {
    return { detail: "Beep or voicemail signal detected", label: "Detected" };
  }
  if (signal === "possible") {
    return { detail: "Detection is not yet conclusive", label: "Possible VM" };
  }
  return { detail: "Listening during the connected call", label: "Listening" };
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

function formatRecordingStatus(status: CallDetailResponse["call"]["recordingStatus"]): string {
  switch (status) {
    case "disabled":
      return "Not enabled";
    case "pending":
      return "Pending";
    case "recording":
      return "Recording";
    case "finalizing":
      return "Verifying";
    case "available":
      return "Available";
    case "expired":
      return "Expired";
    case "failed":
      return "Failed";
  }
}

function UsersPanel({
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
          placeholder="Search name, email, role or status"
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await updateUser(user.id, { name, email, role, ...(password ? { password } : {}) });
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createUser({ email, name, role, password });
      setEmail("");
      setName("");
      setPassword("");
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

function HistoryView({ admin, refreshVersion }: { admin: AdminOverviewResponse; refreshVersion: number }) {
  const detailRequestRef = useRef(0);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [technicalCallId, setTechnicalCallId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CallDetailResponse | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<CallHistoryResponse>({
    items: admin.callHistory,
    page: 1,
    pageSize: 25,
    total: admin.callHistory.length,
    totalPages: admin.callHistory.length ? 1 : 0
  });
  const [query, setQuery] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [outcome, setOutcome] = useState("");
  const [recording, setRecording] = useState<"" | "available" | "missing">("");
  const [agentId, setAgentId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [voicemail, setVoicemail] = useState<"" | "drop" | "signal">("");
  const [avmdReview, setAvmdReview] = useState<"" | "needs_review" | "reviewed" | "uncertain">("");
  const [page, setPage] = useState(1);
  const [historyPending, setHistoryPending] = useState(false);
  const [pcapPendingId, setPcapPendingId] = useState<string | null>(null);

  useEffect(
    () => () => {
      detailRequestRef.current += 1;
    },
    []
  );

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      setHistoryPending(true);
      void fetchCallHistory({
        page,
        pageSize: 25,
        q: query || undefined,
        campaignId: campaignId || undefined,
        agentId: agentId || undefined,
        outcome: outcome || undefined,
        from: historyDateBoundary(dateFrom, false),
        to: historyDateBoundary(dateTo, true),
        voicemail: voicemail || undefined,
        recording: recording || undefined,
        avmdReview: avmdReview || undefined
      })
        .then((next) => {
          if (active) setHistory(next);
        })
        .catch((loadError) => {
          if (active) setError(getErrorMessage(loadError, "Could not load call history"));
        })
        .finally(() => {
          if (active) setHistoryPending(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [
    agentId,
    avmdReview,
    campaignId,
    dateFrom,
    dateTo,
    outcome,
    page,
    query,
    recording,
    refreshVersion,
    voicemail
  ]);

  async function exportHistory() {
    setError(null);
    try {
      const blob = await downloadCallHistoryCsv({
        q: query || undefined,
        campaignId: campaignId || undefined,
        agentId: agentId || undefined,
        outcome: outcome || undefined,
        from: historyDateBoundary(dateFrom, false),
        to: historyDateBoundary(dateTo, true),
        voicemail: voicemail || undefined,
        recording: recording || undefined,
        avmdReview: avmdReview || undefined
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `call-history-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(getErrorMessage(exportError, "Could not export call history"));
    }
  }

  async function toggleCall(callId: string) {
    if (selectedCallId === callId) {
      detailRequestRef.current += 1;
      setSelectedCallId(null);
      setTechnicalCallId(null);
      setDetail(null);
      return;
    }
    setSelectedCallId(callId);
    setTechnicalCallId(null);
    setDetail(null);
    setPendingId(callId);
    setError(null);
    const requestId = ++detailRequestRef.current;
    try {
      const nextDetail = await fetchCallDetail(callId);
      if (requestId !== detailRequestRef.current) return;
      setDetail(nextDetail);
    } catch (detailError) {
      if (requestId !== detailRequestRef.current) return;
      setError(getErrorMessage(detailError, "Could not load call details"));
    } finally {
      if (requestId === detailRequestRef.current) setPendingId(null);
    }
  }

  async function downloadPcap(callId: string) {
    setPcapPendingId(callId);
    setError(null);
    try {
      const blob = await downloadCallPcap(callId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${callId}.pcap`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(getErrorMessage(downloadError, "Could not download PCAP capture"));
    } finally {
      setPcapPendingId(null);
    }
  }

  return (
    <article className="panel wide-panel">
      <PanelHeader
        icon={History}
        title="Call history"
        meta={historyPending ? "loading" : `${history.total} calls`}
      />
      <div className="history-filters">
        <label>
          Search
          <input
            aria-label="Search call history"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Lead, phone, campaign or agent"
          />
        </label>
        <label>
          Campaign
          <select
            value={campaignId}
            onChange={(event) => {
              setCampaignId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All campaigns</option>
            {admin.campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent
          <select
            value={agentId}
            onChange={(event) => {
              setAgentId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All agents</option>
            {admin.users
              .filter((user) => user.role === "agent")
              .map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Outcome
          <select
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All outcomes</option>
            {[
              "answered",
              "not_answered",
              "busy",
              "failed",
              "voicemail_detected",
              "voicemail_dropped",
              "agent_canceled",
              "customer_hung_up",
              "suppressed"
            ].map((item) => (
              <option key={item} value={item}>
                {formatOutcomeFilterOption(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            aria-label="History from date"
            type="date"
            value={dateFrom}
            onChange={(event) => {
              setDateFrom(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          To
          <input
            aria-label="History to date"
            type="date"
            value={dateTo}
            onChange={(event) => {
              setDateTo(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          Voicemail
          <select
            value={voicemail}
            onChange={(event) => {
              setVoicemail(event.target.value as typeof voicemail);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="drop">Drop requested</option>
            <option value="signal">Signal detected</option>
          </select>
        </label>
        <label>
          Recording
          <select
            value={recording}
            onChange={(event) => {
              setRecording(event.target.value as typeof recording);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="available">Available</option>
            <option value="missing">Missing</option>
          </select>
        </label>
        <label>
          AVMD review
          <select
            aria-label="AVMD review"
            value={avmdReview}
            onChange={(event) => {
              setAvmdReview(event.target.value as typeof avmdReview);
              setPage(1);
            }}
          >
            <option value="">Any</option>
            <option value="needs_review">Needs review</option>
            <option value="reviewed">Reviewed</option>
            <option value="uncertain">Uncertain</option>
          </select>
        </label>
        <button
          className="secondary-action compact-action"
          onClick={() => void exportHistory()}
          type="button"
        >
          Export CSV
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="history-head" aria-hidden="true">
        <span>Lead</span>
        <span>Campaign</span>
        <span>Agent</span>
        <span>Started</span>
        <span>Status</span>
      </div>
      <div className="table-list">
        {history.items.map((call) => (
          <div className="history-entry" key={call.id}>
            <button
              aria-expanded={selectedCallId === call.id}
              className="table-row history-row clickable-row"
              onClick={() => void toggleCall(call.id)}
              type="button"
            >
              <span className="history-lead">
                <strong>{call.leadName}</strong>
                <small>{call.phoneNumber}</small>
              </span>
              <span>{call.campaignName}</span>
              <span>{call.agentName}</span>
              <span>
                {formatDateTime(call.createdAt)}
                <small>{formatDuration(call.durationSeconds)}</small>
              </span>
              <span className="history-outcome-stack">
                <b className={`outcome-badge outcome-${call.outcome ?? call.state}`}>
                  {formatCallLifecycleStatus(call.state, call.outcome)}
                </b>
                {call.avmdReviewStatus && (
                  <small className={`avmd-review-badge ${call.avmdReviewStatus}`}>
                    {formatAvmdReviewStatus(call.avmdReviewStatus)}
                  </small>
                )}
              </span>
            </button>
            {selectedCallId === call.id && (
              <div className="call-detail">
                {pendingId === call.id && <p>Loading call details…</p>}
                {detail?.call.id === call.id && (
                  <>
                    <div className="call-detail-summary">
                      <span>
                        <strong>Type</strong>
                        {detail.call.manualDial ? "Manual dial" : "Campaign lead"}
                      </span>
                      <span>
                        <strong>Answered</strong>
                        {detail.call.answeredAt ? formatDateTime(detail.call.answeredAt) : "Not answered"}
                      </span>
                      <span>
                        <strong>Ended</strong>
                        {detail.call.endedAt ? formatDateTime(detail.call.endedAt) : "In progress"}
                      </span>
                      <span>
                        <strong>Recording</strong>
                        {formatRecordingStatus(detail.call.recordingStatus)}
                      </span>
                      <span>
                        <strong>Packet capture</strong>
                        {detail.call.pcapStatus ? formatPcapStatus(detail.call.pcapStatus) : "Not captured"}
                      </span>
                      {detail.call.pcapFileSizeBytes !== null && (
                        <span>
                          <strong>PCAP size</strong>
                          {formatBytes(detail.call.pcapFileSizeBytes)}
                        </span>
                      )}
                      {detail.call.pcapFailureReason && (
                        <span>
                          <strong>PCAP issue</strong>
                          {detail.call.pcapFailureReason}
                        </span>
                      )}
                      {detail.call.recordingDurationSeconds !== null && (
                        <span>
                          <strong>Recording length</strong>
                          {formatDuration(detail.call.recordingDurationSeconds)}
                        </span>
                      )}
                      {detail.call.recordingFileSizeBytes !== null && (
                        <span>
                          <strong>Recording size</strong>
                          {formatBytes(detail.call.recordingFileSizeBytes)}
                        </span>
                      )}
                      {detail.call.recordingIntegrityCheckedAt && (
                        <span>
                          <strong>Integrity checked</strong>
                          {formatDateTime(detail.call.recordingIntegrityCheckedAt)}
                        </span>
                      )}
                      {detail.call.recordingFailureReason && (
                        <span>
                          <strong>Recording issue</strong>
                          {detail.call.recordingFailureReason}
                        </span>
                      )}
                      <span>
                        <strong>VM signal</strong>
                        {detail.call.voicemailSignal ?? "None"}
                        {detail.call.voicemailConfidence !== null
                          ? ` (${detail.call.voicemailConfidence})`
                          : ""}
                      </span>
                      <span>
                        <strong>Hangup</strong>
                        {detail.call.hangupCause ?? detail.call.lastReasonCode ?? "Not reported"}
                      </span>
                    </div>
                    {detail.call.recordingAvailable && (
                      <CallRecordingPlayer callId={detail.call.id} leadName={detail.call.leadName} />
                    )}
                    <AvmdReviewCard
                      detail={detail}
                      key={detail.call.id}
                      onSaved={(review) => {
                        setDetail((current) => (current ? { ...current, avmdReview: review } : current));
                        setHistory((current) => ({
                          ...current,
                          items: current.items.map((item) =>
                            item.id === call.id
                              ? {
                                  ...item,
                                  avmdReviewStatus:
                                    review.actualParty === "uncertain" ? "uncertain" : "reviewed"
                                }
                              : item
                          )
                        }));
                      }}
                    />
                    {detail.call.pcapAvailable && (
                      <div className="pcap-download-card">
                        <div>
                          <strong>Packet capture</strong>
                          <small>Filtered to this call's SIP signaling and media ports.</small>
                        </div>
                        <button
                          className="secondary-action compact-action"
                          disabled={pcapPendingId === call.id}
                          onClick={() => void downloadPcap(call.id)}
                          type="button"
                        >
                          <Download size={15} />
                          {pcapPendingId === call.id ? "Preparing" : "Download PCAP"}
                        </button>
                      </div>
                    )}
                    <div className="technical-details">
                      <button
                        aria-expanded={technicalCallId === call.id}
                        className="secondary-action compact-action technical-toggle"
                        onClick={() => setTechnicalCallId(technicalCallId === call.id ? null : call.id)}
                        type="button"
                      >
                        <Activity size={14} />
                        {technicalCallId === call.id ? "Hide technical details" : "Show technical details"}
                      </button>
                      {technicalCallId === call.id && (
                        <div className="technical-call-details">
                          <CallTechnicalEvidence detail={detail} />
                          <div className="call-leg-grid">
                            {detail.legs?.map((leg) => (
                              <div className="call-leg-card" key={leg.type}>
                                <strong>{leg.type === "agent" ? "Agent leg" : "Customer leg"}</strong>
                                <span>{leg.state}</span>
                                <code>{leg.freeswitchUuid ?? "UUID not assigned"}</code>
                                {leg.sipUri && <small>{leg.sipUri}</small>}
                                {(leg.hangupCause || leg.reasonCode) && (
                                  <small>
                                    {[leg.hangupCause, leg.reasonCode].filter(Boolean).join(" · ")}
                                  </small>
                                )}
                              </div>
                            ))}
                          </div>
                          <div className="history-timeline">
                            {detail.timelineTruncated && (
                              <p className="analytics-note">
                                Showing the latest {detail.timeline.length} of {detail.timelineTotal} recorded
                                events.
                              </p>
                            )}
                            {detail.timeline.map((item, index) => (
                              <div className="timeline-item" key={`${item.at}-${item.eventType}-${index}`}>
                                <span>{formatDateTime(item.at)}</span>
                                <p>{item.label}</p>
                                {(item.reasonCode || item.freeSwitchEventName || item.apiCommandName) && (
                                  <small>
                                    {[item.freeSwitchEventName, item.apiCommandName, item.reasonCode]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </small>
                                )}
                                {(item.agentLegUuid || item.customerLegUuid) && (
                                  <code>
                                    {[
                                      item.agentLegUuid && `agent ${item.agentLegUuid}`,
                                      item.customerLegUuid && `customer ${item.customerLegUuid}`
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </code>
                                )}
                              </div>
                            ))}
                            {!detail.timeline.length && (
                              <p className="empty-state">No call events recorded.</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {!history.items.length && <div className="empty-row">No calls match these filters</div>}
      </div>
      <div className="pagination-controls">
        <button
          className="secondary-action compact-action"
          disabled={history.page <= 1 || historyPending}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          type="button"
        >
          Previous
        </button>
        <span>
          Page {history.page} of {Math.max(history.totalPages, 1)}
        </span>
        <button
          className="secondary-action compact-action"
          disabled={history.page >= history.totalPages || historyPending}
          onClick={() => setPage((current) => current + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </article>
  );
}

function historyDateBoundary(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (endOfDay) {
    date.setDate(date.getDate() + 1);
    date.setMilliseconds(-1);
  }
  return date.toISOString();
}

function formatAvmdReviewStatus(
  status: NonNullable<AdminOverviewResponse["callHistory"][number]["avmdReviewStatus"]>
): string {
  const labels = {
    needs_review: "Needs AVMD review",
    reviewed: "AVMD reviewed",
    uncertain: "AVMD uncertain"
  } as const;
  return labels[status];
}

function formatAvmdPrediction(detail: CallDetailResponse): string {
  const signal = detail.call.voicemailSignal;
  const label = signal === "detected" ? "Detected" : signal === "possible" ? "Possible" : "No detection";
  return detail.call.voicemailConfidence === null
    ? label
    : `${label} · confidence ${detail.call.voicemailConfidence}`;
}

function formatAvmdActualParty(actualParty: CallAvmdReview["actualParty"]): string {
  const labels = {
    human: "Human",
    machine: "Voicemail / machine",
    uncertain: "Uncertain"
  } as const;
  return labels[actualParty];
}

function AvmdReviewCard({
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

function formatMediaValue(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function MediaQualityCard({ item }: { item: CallMediaQuality }) {
  return (
    <div className="call-media-quality-card">
      <div>
        <strong>{item.legType === "agent" ? "Agent leg" : "Customer leg"}</strong>
        {item.suspectedOneWayAudio && <StatusBadge label="Suspected one-way" tone="warn" />}
      </div>
      <dl>
        <div>
          <dt>Read codec</dt>
          <dd>{item.readCodec ?? "—"}</dd>
        </div>
        <div>
          <dt>Write codec</dt>
          <dd>{item.writeCodec ?? "—"}</dd>
        </div>
        {item.sipGateway && (
          <div>
            <dt>SIP gateway</dt>
            <dd>{item.sipGateway}</dd>
          </div>
        )}
        {item.sipProfile && (
          <div>
            <dt>SIP profile</dt>
            <dd>{item.sipProfile}</dd>
          </div>
        )}
        <div>
          <dt>Inbound media packets</dt>
          <dd>{formatMediaValue(item.inboundMediaPacketCount)}</dd>
        </div>
        <div>
          <dt>Outbound media packets</dt>
          <dd>{formatMediaValue(item.outboundMediaPacketCount)}</dd>
        </div>
        <div>
          <dt>MOS</dt>
          <dd>{formatMediaValue(item.inboundMos)}</dd>
        </div>
        <div>
          <dt>Quality</dt>
          <dd>
            {item.inboundQualityPercentage === null ? "—" : formatPercent(item.inboundQualityPercentage)}
          </dd>
        </div>
      </dl>
      <small>Captured {formatDateTime(item.capturedAt)}</small>
    </div>
  );
}

function browserRate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function BrowserMediaQualityCard({ item }: { item: BrowserMediaTelemetry }) {
  const lossRate = browserRate(
    item.inbound.packetsLost,
    item.inbound.packetsReceived === null || item.inbound.packetsLost === null
      ? null
      : item.inbound.packetsReceived + item.inbound.packetsLost
  );
  const concealedRate = browserRate(item.inbound.concealedSamples, item.inbound.totalSamplesReceived);
  const jitterBufferMs =
    item.inbound.jitterBufferDelaySeconds !== null &&
    item.inbound.jitterBufferEmittedCount !== null &&
    item.inbound.jitterBufferEmittedCount > 0
      ? (item.inbound.jitterBufferDelaySeconds / item.inbound.jitterBufferEmittedCount) * 1000
      : null;
  return (
    <div className="call-media-quality-card">
      <div>
        <strong>Browser WebRTC</strong>
        <StatusBadge label={`${item.sampleCount} samples`} tone="neutral" />
      </div>
      <dl>
        <div>
          <dt>Inbound / outbound codec</dt>
          <dd>
            {item.inbound.codec ?? "—"} / {item.outbound.codec ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Packet loss</dt>
          <dd>{formatNullablePercent(lossRate)}</dd>
        </div>
        <div>
          <dt>Concealed samples</dt>
          <dd>{formatNullablePercent(concealedRate)}</dd>
        </div>
        <div>
          <dt>Maximum jitter</dt>
          <dd>
            {formatBrowserMilliseconds(
              item.inbound.jitterSecondsMax === null ? null : item.inbound.jitterSecondsMax * 1000
            )}
          </dd>
        </div>
        <div>
          <dt>Average jitter buffer</dt>
          <dd>{formatBrowserMilliseconds(jitterBufferMs)}</dd>
        </div>
        <div>
          <dt>Maximum RTT</dt>
          <dd>
            {formatBrowserMilliseconds(
              item.outbound.roundTripTimeSecondsMax === null
                ? null
                : item.outbound.roundTripTimeSecondsMax * 1000
            )}
          </dd>
        </div>
        <div>
          <dt>ICE path</dt>
          <dd>
            {item.connection.localCandidateType ?? "—"} → {item.connection.remoteCandidateType ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Microphone DSP</dt>
          <dd>
            AEC{" "}
            {item.microphone.echoCancellation === null
              ? "—"
              : item.microphone.echoCancellation
                ? "on"
                : "off"}{" "}
            · NS{" "}
            {item.microphone.noiseSuppression === null
              ? "—"
              : item.microphone.noiseSuppression
                ? "on"
                : "off"}{" "}
            · AGC{" "}
            {item.microphone.autoGainControl === null ? "—" : item.microphone.autoGainControl ? "on" : "off"}
          </dd>
        </div>
        <div>
          <dt>Capture format</dt>
          <dd>
            {item.microphone.sampleRate?.toLocaleString() ?? "—"} Hz · {item.microphone.channelCount ?? "—"}{" "}
            ch
          </dd>
        </div>
      </dl>
      <small>Captured {formatDateTime(item.capturedAt)}</small>
    </div>
  );
}

function CallTechnicalEvidence({ detail }: { detail: CallDetailResponse }) {
  const terminalMeasured = detail.call.finalizationLatencyMs !== null;
  return (
    <div className="call-technical-evidence">
      <section>
        <h4>Terminal persistence</h4>
        <div className="technical-evidence-grid">
          <div>
            <span>Source</span>
            <strong>{detail.call.terminalSource ?? "Not measured"}</strong>
          </div>
          <div>
            <span>Event</span>
            <strong>{detail.call.terminalEventName ?? "—"}</strong>
          </div>
          <div>
            <span>FreeSWITCH terminal</span>
            <strong>
              {detail.call.freeswitchTerminalAt ? formatDateTime(detail.call.freeswitchTerminalAt) : "—"}
            </strong>
          </div>
          <div>
            <span>Persisted terminal</span>
            <strong>
              {detail.call.terminalPersistedAt ? formatDateTime(detail.call.terminalPersistedAt) : "—"}
            </strong>
          </div>
          <div>
            <span>Finalization lag</span>
            <strong>
              {terminalMeasured ? formatMilliseconds(detail.call.finalizationLatencyMs) : "Not measured"}
            </strong>
          </div>
        </div>
      </section>
      <section>
        <h4>Media observations</h4>
        <p>FreeSWITCH counters and browser playout evidence are shown separately.</p>
        {detail.mediaQuality.length ? (
          <div className="call-media-quality-grid">
            {detail.mediaQuality.map((item) => (
              <MediaQualityCard item={item} key={item.legType} />
            ))}
          </div>
        ) : (
          <div className="quality-unavailable">No FreeSWITCH media telemetry was captured.</div>
        )}
        {detail.browserMedia ? (
          <div className="call-media-quality-grid">
            <BrowserMediaQualityCard item={detail.browserMedia} />
          </div>
        ) : (
          <div className="quality-unavailable">No browser WebRTC telemetry was captured.</div>
        )}
      </section>
    </div>
  );
}

function CallRecordingPlayer({ callId, leadName }: { callId: string; leadName: string }) {
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

function formatPcapStatus(status: NonNullable<CallDetailResponse["call"]["pcapStatus"]>): string {
  const labels = {
    pending: "Pending",
    capturing: "Capturing",
    available: "Available",
    failed: "Failed",
    expired: "Expired"
  } as const;
  return labels[status];
}

export function formatCallLifecycleStatus(
  state: AdminOverviewResponse["callHistory"][number]["state"],
  outcome: AdminOverviewResponse["callHistory"][number]["outcome"]
): string {
  if (outcome === "voicemail_dropped" || state === "voicemail_playback_completed") {
    return "Completed (voicemail dropped)";
  }
  if (outcome === "failed" || outcome === "suppressed" || state === "failed") {
    return "Failed";
  }
  if (outcome === "not_answered" || outcome === "busy") {
    return "No answer";
  }
  if (outcome === "agent_canceled" || state === "canceled") {
    return "Cancelled";
  }
  if (
    state === "completed" ||
    outcome === "answered" ||
    outcome === "customer_hung_up" ||
    outcome === "voicemail_detected"
  ) {
    return "Completed";
  }
  if (state === "agent_ringing" || state === "customer_ringing") {
    return "Ringing";
  }
  if (state === "agent_answered") {
    return "Answered";
  }
  if (
    state === "bridged" ||
    state === "voicemail_signal_detected" ||
    state === "voicemail_drop_requested" ||
    state === "voicemail_playback_started" ||
    state === "agent_released"
  ) {
    return "In progress";
  }
  return "Calling";
}

function formatOutcomeFilterOption(outcome: string): string {
  const labels: Record<string, string> = {
    answered: "Answered",
    not_answered: "No answer",
    busy: "Busy",
    failed: "Failed",
    voicemail_detected: "Voicemail detected",
    voicemail_dropped: "Voicemail dropped",
    agent_canceled: "Agent cancelled",
    customer_hung_up: "Customer hung up",
    suppressed: "Suppressed"
  };
  return labels[outcome] ?? outcome.replaceAll("_", " ");
}

function SettingsView({
  admin,
  onChanged
}: {
  admin: AdminOverviewResponse;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="operations-grid two">
      <SystemSettingsPanel />
      <FreeSwitchDiagnosticsPanel />
      <article className="panel">
        <PanelHeader icon={BarChart3} title="Business KPIs" meta="Today" />
        <div className="stat-row">
          <Metric label="Attempts" value={admin.stats.attemptedCallsToday} icon={PhoneCall} />
          <Metric label="Answer rate" value={`${admin.stats.contactRate}%`} icon={CheckCircle2} />
          <Metric label="Attempts / hour" value={admin.stats.callsPerHour} icon={Clock3} />
          <Metric
            label="VM completed"
            value={`${admin.stats.voicemailDropCompletionRate}%`}
            icon={Voicemail}
          />
        </div>
        <div className="kpi-outcomes">
          {admin.stats.outcomeDistribution.map((item) => (
            <span key={item.outcome}>
              <strong>{item.count}</strong> {item.outcome.replaceAll("_", " ")}
            </span>
          ))}
        </div>
      </article>
      <UsersPanel onChanged={onChanged} users={admin.users} />
      <AdminAuditPanel users={admin.users} />
    </div>
  );
}

type NumericSystemSetting =
  | "contactMaxAttempts"
  | "contactRetryDelaySeconds"
  | "callHistoryExportMaxRows"
  | "callLogRetentionDays"
  | "callRecordingRetentionDays"
  | "pcapRetentionDays";

function systemSettingNumberDrafts(settings: AdminSystemSettings): Record<NumericSystemSetting, string> {
  return {
    contactMaxAttempts: String(settings.contactMaxAttempts),
    contactRetryDelaySeconds: String(settings.contactRetryDelaySeconds),
    callHistoryExportMaxRows: String(settings.callHistoryExportMaxRows),
    callLogRetentionDays: String(settings.callLogRetentionDays),
    callRecordingRetentionDays: String(settings.callRecordingRetentionDays),
    pcapRetentionDays: String(settings.pcapRetentionDays)
  };
}

function SystemSettingsPanel() {
  const [settings, setSettings] = useState<AdminSystemSettings | null>(null);
  const [numberDrafts, setNumberDrafts] = useState<Record<NumericSystemSetting, string> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetchSystemSettings()
      .then((next) => {
        setSettings(next);
        setNumberDrafts(systemSettingNumberDrafts(next));
      })
      .catch((loadError) => setError(getErrorMessage(loadError, "Could not load system settings")));
  }, []);

  useEffect(() => {
    if (settings?.alertmanagerApplyStatus?.state !== "pending") return undefined;
    let active = true;
    let timer: number | null = null;
    const pollApplyStatus = async () => {
      try {
        const next = await fetchSystemSettings();
        if (!active) return;
        setSettings((current) =>
          current
            ? {
                ...current,
                alertmanagerApplyStatus: next.alertmanagerApplyStatus,
                updatedAt: next.updatedAt
              }
            : next
        );
        if (next.alertmanagerApplyStatus?.state === "pending") {
          timer = window.setTimeout(() => void pollApplyStatus(), 1_500);
        }
      } catch {
        if (active) timer = window.setTimeout(() => void pollApplyStatus(), 1_500);
      }
    };
    timer = window.setTimeout(() => void pollApplyStatus(), 1_500);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [settings?.alertmanagerApplyStatus?.state]);

  if (!settings) {
    return (
      <article className="panel">
        <PanelHeader icon={Settings2} title="System policies" meta="Loading" />
        {error && <p className="form-error">{error}</p>}
      </article>
    );
  }

  const set = <K extends keyof AdminSystemSettings>(key: K, value: AdminSystemSettings[K]) =>
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  const number = (key: NumericSystemSetting) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    if (!/^\d*$/.test(value)) return;
    setNumberDrafts((current) => ({ ...(current ?? systemSettingNumberDrafts(settings)), [key]: value }));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    setMessage(null);
    if (!numberDrafts || Object.values(numberDrafts).some((value) => value === "")) {
      setError("Fill in all numeric settings");
      setPending(false);
      return;
    }
    const parsedSettings = {
      ...settings,
      ...Object.fromEntries(Object.entries(numberDrafts).map(([key, value]) => [key, Number(value)]))
    } as AdminSystemSettings;
    const {
      availableAlertChannels: _available,
      alertmanagerApplyStatus: _applyStatus,
      updatedAt: _updatedAt,
      ...input
    } = parsedSettings;
    try {
      const updated = await updateSystemSettings(input as UpdateAdminSystemSettingsRequest);
      setSettings(updated);
      setNumberDrafts(systemSettingNumberDrafts(updated));
      setMessage("Settings saved");
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Could not save system settings"));
    } finally {
      setPending(false);
    }
  };
  const alertmanagerApplyStatus = settings.alertmanagerApplyStatus;

  return (
    <article className="panel form-panel system-settings-panel">
      <PanelHeader icon={Settings2} title="System policies" meta="Save and runtime status" />
      <form className="stack-form" onSubmit={submit}>
        <div className="inline-fields">
          <label>
            Default phone country
            <input
              maxLength={2}
              value={settings.defaultPhoneCountryCode}
              onChange={(e) => set("defaultPhoneCountryCode", e.target.value.toUpperCase())}
            />
          </label>
          <label>
            Call history export rows
            <input
              min={100}
              max={250000}
              inputMode="numeric"
              type="text"
              value={numberDrafts?.callHistoryExportMaxRows ?? ""}
              onChange={number("callHistoryExportMaxRows")}
            />
          </label>
        </div>
        <div className="inline-fields">
          <label>
            Contact attempts
            <input
              min={1}
              max={100}
              inputMode="numeric"
              type="text"
              value={numberDrafts?.contactMaxAttempts ?? ""}
              onChange={number("contactMaxAttempts")}
            />
          </label>
          <label>
            Retry delay, seconds
            <input
              min={0}
              max={604800}
              inputMode="numeric"
              type="text"
              value={numberDrafts?.contactRetryDelaySeconds ?? ""}
              onChange={number("contactRetryDelaySeconds")}
            />
          </label>
        </div>
        <div className="inline-fields">
          <label>
            Call history, days
            <input
              min={1}
              max={3650}
              inputMode="numeric"
              type="text"
              value={numberDrafts?.callLogRetentionDays ?? ""}
              onChange={number("callLogRetentionDays")}
            />
          </label>
          <label>
            Recordings, days
            <input
              min={1}
              max={3650}
              inputMode="numeric"
              type="text"
              value={numberDrafts?.callRecordingRetentionDays ?? ""}
              onChange={number("callRecordingRetentionDays")}
            />
          </label>
          <label>
            PCAP files, days
            <input
              min={1}
              max={365}
              inputMode="numeric"
              type="text"
              value={numberDrafts?.pcapRetentionDays ?? ""}
              onChange={number("pcapRetentionDays")}
            />
          </label>
          <label>
            Trunk caller ID
            <input
              maxLength={80}
              value={settings.sipTrunkCallerId ?? ""}
              onChange={(e) => set("sipTrunkCallerId", e.target.value || null)}
            />
          </label>
        </div>
        <div className="toggle-row">
          <label>
            <input
              checked={settings.retentionEnabled}
              type="checkbox"
              onChange={(e) => set("retentionEnabled", e.target.checked)}
            />
            Automatic retention
          </label>
          <label>
            <input
              checked={settings.pcapCaptureEnabled}
              type="checkbox"
              onChange={(e) => set("pcapCaptureEnabled", e.target.checked)}
            />
            Capture call PCAPs
          </label>
        </div>
        <div className="inline-fields">
          <label>
            Alert repeat interval
            <input
              placeholder="4h"
              value={settings.alertmanagerRepeatInterval}
              onChange={(e) => set("alertmanagerRepeatInterval", e.target.value)}
            />
          </label>
        </div>
        <div className="toggle-row">
          <label>
            <input
              checked={settings.alertmanagerWebhookEnabled}
              disabled={!settings.availableAlertChannels.webhook}
              type="checkbox"
              onChange={(e) => set("alertmanagerWebhookEnabled", e.target.checked)}
            />
            Webhook alerts
          </label>
          <label>
            <input
              checked={settings.alertmanagerTelegramEnabled}
              disabled={!settings.availableAlertChannels.telegram}
              type="checkbox"
              onChange={(e) => set("alertmanagerTelegramEnabled", e.target.checked)}
            />
            Telegram alerts
          </label>
          <label>
            <input
              checked={settings.alertmanagerSlackEnabled}
              disabled={!settings.availableAlertChannels.slack}
              type="checkbox"
              onChange={(e) => set("alertmanagerSlackEnabled", e.target.checked)}
            />
            Slack alerts
          </label>
        </div>
        <p className="panel-note">
          Alert credentials remain deployment-managed; this screen only enables configured channels.
        </p>
        {alertmanagerApplyStatus?.state === "pending" && (
          <p aria-live="polite" className="panel-note" role="status">
            Alertmanager configuration is saved; runtime reload is pending.
          </p>
        )}
        {alertmanagerApplyStatus?.state === "applied" && (
          <p aria-live="polite" className="form-success" role="status">
            Alertmanager configuration applied
            {alertmanagerApplyStatus.lastSuccessAt
              ? ` at ${formatDateTime(alertmanagerApplyStatus.lastSuccessAt)}`
              : ""}
            .
          </p>
        )}
        {alertmanagerApplyStatus?.state === "failed" && (
          <p aria-live="assertive" className="form-error" role="alert">
            Alertmanager reload failed
            {alertmanagerApplyStatus.error ? `: ${alertmanagerApplyStatus.error}` : "."}
          </p>
        )}
        {alertmanagerApplyStatus?.state === "not_configured" && (
          <p className="panel-note">Alertmanager runtime reload is not configured for this deployment.</p>
        )}
        {!alertmanagerApplyStatus && (
          <p className="panel-note">Alertmanager apply status is unavailable during the API upgrade.</p>
        )}
        {error && <p className="form-error">{error}</p>}
        {message && <p className="form-success">{message}</p>}
        <button className="primary-action" disabled={pending} type="submit">
          {pending ? "Saving…" : "Save settings"}
        </button>
      </form>
    </article>
  );
}

function AdminAuditPanel({ users }: { users: PublicUser[] }) {
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

function SuppressionView({
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

function FreeSwitchDiagnosticsPanel() {
  const [diagnostics, setDiagnostics] = useState<FreeSwitchDiagnosticsResponse | null>(null);
  const [safeTest, setSafeTest] = useState<FreeSwitchSafeTestResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setPending(true);
    setError(null);
    try {
      setDiagnostics(await fetchFreeSwitchDiagnostics());
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Could not load call control status");
    } finally {
      setPending(false);
    }
  }

  async function runSafeTest() {
    setTesting(true);
    setError(null);
    try {
      const result = await runFreeSwitchSafeTest();
      setSafeTest(result);
      setDiagnostics(await fetchFreeSwitchDiagnostics());
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Could not run call control test");
    } finally {
      setTesting(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const trunkTone = diagnostics ? toneForTrunk(diagnostics.trunk.status) : "neutral";
  const eslTone = diagnostics ? toneForHealth(diagnostics.esl.status) : "neutral";

  return (
    <article className="panel diagnostics-panel">
      <PanelHeader icon={Radio} title="Call control" meta={diagnostics?.trunk.mode ?? "Checking"} />
      <div className="diagnostics-actions">
        <button className="secondary-action" disabled={pending || testing} onClick={refresh} type="button">
          <Activity size={17} />
          {pending ? "Refreshing" : "Refresh"}
        </button>
        <button
          className="primary-action"
          disabled={testing || !diagnostics?.controlPlane.safeTestAvailable}
          onClick={runSafeTest}
          type="button"
        >
          <CheckCircle2 size={17} />
          {testing ? "Running" : "Safe test"}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="diagnostics-grid">
        <div className={`diagnostic-card ${eslTone}`}>
          <span>ESL</span>
          <strong>{diagnostics ? displayHealthStatus(diagnostics.esl.status) : "checking"}</strong>
          <small>{diagnostics?.esl.message ?? "Waiting for status"}</small>
        </div>
        <div className={`diagnostic-card ${trunkTone}`}>
          <span>Provider trunk</span>
          <strong>{diagnostics ? displayTrunkStatus(diagnostics.trunk.status) : "checking"}</strong>
          <small>{diagnostics?.trunk.summary ?? "Waiting for status"}</small>
        </div>
      </div>
      {diagnostics && (
        <div className="diagnostic-flags">
          <StatusBadge
            label={diagnostics.trunk.proxyConfigured ? "Proxy set" : "Proxy missing"}
            tone={diagnostics.trunk.proxyConfigured ? "good" : "bad"}
          />
          <StatusBadge
            label={diagnostics.trunk.usernameConfigured ? "User set" : "User missing"}
            tone={
              diagnostics.trunk.mode === "ip_auth" || diagnostics.trunk.usernameConfigured ? "good" : "bad"
            }
          />
          <StatusBadge
            label={diagnostics.trunk.callerIdConfigured ? "Caller ID set" : "Caller ID missing"}
            tone={diagnostics.trunk.callerIdConfigured ? "good" : "neutral"}
          />
        </div>
      )}
      {safeTest && (
        <div className={`safe-test-result ${safeTest.ok ? "good" : "bad"}`}>
          {safeTest.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <div>
            <strong>{safeTest.ok ? "Safe test passed" : "Safe test failed"}</strong>
            <span>{safeTest.message}</span>
          </div>
        </div>
      )}
    </article>
  );
}

function toneForHealth(status: FreeSwitchDiagnosticsResponse["esl"]["status"]): "good" | "bad" | "neutral" {
  if (status === "ok") {
    return "good";
  }
  if (status === "error") {
    return "bad";
  }
  return "neutral";
}

function displayHealthStatus(status: FreeSwitchDiagnosticsResponse["esl"]["status"]): string {
  if (status === "ok") {
    return "OK";
  }
  return status;
}

function toneForTrunk(status: FreeSwitchDiagnosticsResponse["trunk"]["status"]): "good" | "bad" | "neutral" {
  if (status === "ready") {
    return "good";
  }
  if (status === "not_configured" || status === "unknown") {
    return "neutral";
  }
  return "bad";
}

function displayTrunkStatus(status: FreeSwitchDiagnosticsResponse["trunk"]["status"]): string {
  if (status === "ready") {
    return "OK";
  }
  return status;
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
