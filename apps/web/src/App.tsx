import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  BarChart3,
  CheckCircle2,
  Clock3,
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
  Shield,
  Square,
  Trash2,
  Upload,
  UserPlus,
  Users,
  Voicemail,
  XCircle
} from "lucide-react";
import {
  isApiError,
  clearStoredToken,
  completeContact,
  createCampaign,
  createContact,
  createSuppression,
  createUser,
  deleteCampaign,
  deleteRecording,
  deleteSuppression,
  deleteUser,
  dropVoicemail,
  endCall,
  fetchAdminOverview,
  fetchCampaignContacts,
  fetchCsvImports,
  fetchCsvImportDetail,
  fetchAgentDesk,
  fetchFreeSwitchDiagnostics,
  fetchMe,
  getRecordingAudioUrl,
  getStoredToken,
  importCampaignCsvFile,
  login,
  runFreeSwitchSafeTest,
  sendDtmf,
  setStoredToken,
  setDefaultRecording,
  startLeadCall,
  startManualCall,
  startNextCall,
  suppressContact,
  updateCampaign,
  uploadRecording,
  validateManualDial
} from "./api";
import { useSoftphoneRegistration } from "./softphone";
import type { SoftphoneRuntime } from "./softphone";
import type {
  AdminOverviewResponse,
  AgentDeskResponse,
  CampaignContactListItem,
  CampaignContactsResponse,
  CsvImportDetailResponse,
  CsvImportSummary,
  FreeSwitchDiagnosticsResponse,
  FreeSwitchSafeTestResponse,
  ImportCsvResponse,
  LeadSummary,
  ManualDialValidationResponse,
  PublicUser
} from "./types";

type View = "desk" | "campaigns" | "recordings" | "history" | "settings";
type AgentDeskWithCampaign = AgentDeskResponse & { campaign: NonNullable<AgentDeskResponse["campaign"]> };

const navItems: Array<{ id: View; label: string; icon: typeof BarChart3 }> = [
  { id: "desk", label: "Agent Desk", icon: BarChart3 },
  { id: "campaigns", label: "Campaigns", icon: Upload },
  { id: "recordings", label: "Voicemail", icon: FileAudio },
  { id: "history", label: "Call History", icon: History },
  { id: "settings", label: "Settings", icon: Shield }
];

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function App() {
  const [tokenReady, setTokenReady] = useState(false);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [desk, setDesk] = useState<AgentDeskResponse | null>(null);
  const [admin, setAdmin] = useState<AdminOverviewResponse | null>(null);
  const [csvImports, setCsvImports] = useState<CsvImportSummary[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [view, setView] = useState<View>("desk");
  const [error, setError] = useState<string | null>(null);
  const [manualDialNumber, setManualDialNumber] = useState("");
  const activeCallPollRequestRef = useRef(0);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setTokenReady(true);
      return;
    }

    void hydrateSession();
  }, []);

  function resetSession(nextError: string | null = null) {
    clearStoredToken();
    setUser(null);
    setDesk(null);
    setAdmin(null);
    setCsvImports([]);
    setSelectedCampaignId(null);
    setManualDialNumber("");
    setView("desk");
    setError(nextError);
  }

  async function hydrateSession() {
    try {
      const [{ user: nextUser }, nextDesk] = await Promise.all([fetchMe(), fetchAgentDesk(selectedCampaignId ?? undefined)]);
      setUser(nextUser);
      setDesk(nextDesk);
      setSelectedCampaignId(nextDesk.campaign?.id ?? null);
      if (nextUser.role === "admin") {
        const [nextAdmin, nextImports] = await Promise.all([fetchAdminOverview(), fetchCsvImports()]);
        setAdmin(nextAdmin);
        setCsvImports(nextImports.imports);
      }
    } catch (sessionError) {
      resetSession(getErrorMessage(sessionError, "Session expired"));
    } finally {
      setTokenReady(true);
    }
  }

  async function handleLogin(email: string, password: string) {
    setError(null);
    const response = await login(email, password);
    setStoredToken(response.token);
    await hydrateSession();
  }

  function handleLogout() {
    resetSession();
  }

  async function handleCampaignChange(campaignId: string) {
    setSelectedCampaignId(campaignId);
    setDesk(await fetchAgentDesk(campaignId));
  }

  useEffect(() => {
    if (!user || !desk?.activeCall) {
      return undefined;
    }

    let stopped = false;
    const refreshDesk = async () => {
      const requestId = ++activeCallPollRequestRef.current;
      try {
        const nextDesk = await fetchAgentDesk(selectedCampaignId ?? desk.campaign?.id);
        if (stopped || requestId !== activeCallPollRequestRef.current) {
          return;
        }
        setDesk(nextDesk);
        setSelectedCampaignId(nextDesk.campaign?.id ?? null);
      } catch (refreshError) {
        if (stopped || requestId !== activeCallPollRequestRef.current) {
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
      activeCallPollRequestRef.current += 1;
      window.clearInterval(interval);
    };
  }, [desk?.activeCall?.id, desk?.campaign?.id, selectedCampaignId, user]);

  const softphoneRuntime = useSoftphoneRegistration(user);

  if (!tokenReady) {
    return <div className="boot-screen">Loading dialer</div>;
  }

  if (!user || !desk) {
    return <LoginScreen error={error} onLogin={handleLogin} />;
  }

  const isAgentOnly = user.role === "agent";
  const activeView = isAgentOnly ? "desk" : view;

  return (
    <div className={isAgentOnly ? "app-shell agent-shell" : "app-shell"}>
      {!isAgentOnly && (
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <Radio size={19} />
            </div>
            <div>
              <strong>Outbound</strong>
              <span>Dialer</span>
            </div>
          </div>
          <nav className="nav-list">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={item.id === activeView ? "nav-item active" : "nav-item"}
                  key={item.id}
                  onClick={() => setView(item.id)}
                  type="button"
                  title={item.label}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            <span>{desk.campaign?.name ?? "No active campaign"}</span>
            <strong>{desk.campaign?.status ?? "setup"}</strong>
          </div>
        </aside>
      )}

      <main className="workspace">
        <TopBar desk={desk} softphone={softphoneRuntime} user={user} onLogout={handleLogout} />
        {activeView === "desk" && (
          <AgentDesk
            desk={desk}
            manualDialNumber={manualDialNumber}
            onCampaignChange={handleCampaignChange}
            onDeskChanged={setDesk}
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
              setView("desk");
            }}
            view={activeView}
            user={user}
          />
        )}
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
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
            <strong>Outbound</strong>
            <span>Dialer</span>
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
          {(formError || error) && <p className="form-error">{formError ?? error}</p>}
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
  softphone,
  user
}: {
  desk: AgentDeskResponse;
  onLogout: () => void;
  softphone: SoftphoneRuntime;
  user: PublicUser;
}) {
  return (
    <header className="topbar">
      <p>{desk.campaign?.name ?? "No active campaign"}</p>
      <div className="topbar-actions">
        <StatusBadge
          label={softphone.registered ? "app registered" : "app offline"}
          tone={softphone.registered ? "good" : "bad"}
        />
        <StatusBadge
          label={softphone.microphoneAllowed ? "Mic allowed" : "Mic blocked"}
          tone={softphone.microphoneAllowed ? "good" : "bad"}
        />
        <div className="user-pill">
          <Headphones size={16} />
          <span>{user.name}</span>
        </div>
        <button className="icon-button" onClick={onLogout} title="Log out" type="button">
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
  const [deskMode, setDeskMode] = useState<"ready" | "manual">("ready");
  const [callNextPending, setCallNextPending] = useState(false);
  const [callNextError, setCallNextError] = useState<string | null>(null);
  const [endCallPending, setEndCallPending] = useState(false);
  const [dropVoicemailPending, setDropVoicemailPending] = useState(false);
  const [dtmfPending, setDtmfPending] = useState(false);
  const [endCallError, setEndCallError] = useState<string | null>(null);
  const campaign = desk.campaign;

  useEffect(() => {
    if (manualDialNumber && !desk.activeCall && campaign?.manualDialingEnabled) {
      setDeskMode("manual");
    }
  }, [campaign?.manualDialingEnabled, desk.activeCall, manualDialNumber]);

  async function callNext() {
    if (!campaign) {
      setCallNextError("No active campaign is available");
      return;
    }
    if (!softphone.registered) {
      setCallNextError("Softphone must be registered before starting a call");
      return;
    }
    setCallNextPending(true);
    setCallNextError(null);
    try {
      onDeskChanged(await startNextCall({ campaignId: campaign.id }));
    } catch (error) {
      setCallNextError(error instanceof Error ? error.message : "Could not start next call");
    } finally {
      setCallNextPending(false);
    }
  }

  async function callLead(lead: LeadSummary) {
    if (!softphone.registered) {
      setCallNextError("Softphone must be registered before starting a call");
      return;
    }
    setCallNextPending(true);
    setCallNextError(null);
    try {
      onDeskChanged(await startLeadCall(lead.id));
    } catch (error) {
      setCallNextError(error instanceof Error ? error.message : "Could not start lead call");
    } finally {
      setCallNextPending(false);
    }
  }

  async function hangUp(callId: string) {
    setEndCallPending(true);
    setEndCallError(null);
    try {
      onDeskChanged(await endCall(callId, { campaignId: campaign?.id, outcome: "agent_canceled" }));
    } catch (error) {
      setEndCallError(error instanceof Error ? error.message : "Could not end call");
    } finally {
      setEndCallPending(false);
    }
  }

  async function handleDropVoicemail(callId: string, recordingId?: string) {
    setDropVoicemailPending(true);
    setEndCallError(null);
    try {
      onDeskChanged(await dropVoicemail(callId, { campaignId: campaign?.id, recordingId }));
    } catch (error) {
      setEndCallError(error instanceof Error ? error.message : "Could not drop voicemail");
    } finally {
      setDropVoicemailPending(false);
    }
  }

  async function handleSendDtmf(callId: string, digit: string) {
    setDtmfPending(true);
    setEndCallError(null);
    try {
      onDeskChanged(await sendDtmf(callId, { campaignId: campaign?.id, digit }));
    } catch (error) {
      setEndCallError(error instanceof Error ? error.message : "Could not send DTMF");
    } finally {
      setDtmfPending(false);
    }
  }

  if (!campaign) {
    return (
      <section className={desk.activeCall ? "agent-grid active-agent-grid" : "ready-desk-grid"}>
        <NoCampaignPanel />
        {desk.activeCall && (
          <ActiveCall
            desk={desk}
            dropPending={dropVoicemailPending}
            error={endCallError}
            onDropVoicemail={handleDropVoicemail}
            onHangUp={hangUp}
            onSendDtmf={handleSendDtmf}
            dtmfPending={dtmfPending}
            pending={endCallPending}
          />
        )}
        <AgentNoCampaignStatus desk={desk} softphone={softphone} />
      </section>
    );
  }

  const campaignDesk = desk as AgentDeskWithCampaign;

  if (desk.activeCall) {
    return (
      <section className="agent-grid active-agent-grid">
        <LeadQueue
          canStartCalls={softphone.registered}
          error={callNextError}
          leads={desk.leads}
          onCallLead={callLead}
          onCallNext={callNext}
          pending={callNextPending}
          showRecommendedCall={false}
        />
        <ActiveCall
          desk={desk}
          dropPending={dropVoicemailPending}
          error={endCallError}
          onDropVoicemail={handleDropVoicemail}
          onHangUp={hangUp}
          onSendDtmf={handleSendDtmf}
          dtmfPending={dtmfPending}
          pending={endCallPending}
        />
        <AgentStatusPanel
          desk={campaignDesk}
          mode="active"
          onCampaignChange={onCampaignChange}
          onOpenManual={() => setDeskMode("manual")}
          softphone={softphone}
        />
      </section>
    );
  }

  if (deskMode === "manual" && campaign.manualDialingEnabled) {
    return (
      <ManualDialSurface
        desk={campaignDesk}
        onDeskChanged={onDeskChanged}
        onOpenQueue={() => setDeskMode("ready")}
        onPhoneNumberChange={onManualDialNumberChange}
        phoneNumber={manualDialNumber}
        softphone={softphone}
      />
    );
  }

  return (
    <section className="ready-desk-grid">
      <LeadQueue
        canStartCalls={softphone.registered}
        error={callNextError}
        leads={desk.leads}
        onCallLead={callLead}
        onCallNext={callNext}
        pending={callNextPending}
      />
      <AgentStatusPanel
        desk={campaignDesk}
        mode="ready"
        onCampaignChange={onCampaignChange}
        onOpenManual={() => setDeskMode("manual")}
        softphone={softphone}
      />
    </section>
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
  const recommended = leads.find((lead) => lead.status === "ready") ?? leads[0];

  return (
    <article className="panel lead-queue next-leads-panel">
      <div className="surface-heading">
        <h2>Next leads</h2>
        <p>No live call is active. Start the next call from the campaign queue.</p>
      </div>
      {error && <p className="form-error">{error}</p>}
      {showRecommendedCall && recommended && (
        <div className="recommended-call">
          <h3>Next lead</h3>
          <p>
            {recommended.name}, {recommended.phoneNumber}
          </p>
          <button className="primary-action teal-action" disabled={pending || !canStartCalls} onClick={onCallNext} type="button">
            <PhoneCall size={17} />
            {pending ? "Starting" : "Start next call"}
          </button>
        </div>
      )}
      <div className="lead-table" role="table" aria-label="Next leads">
        <div className="lead-table-row lead-table-head" role="row">
          <span>Lead</span>
          <span>Phone</span>
          <span>Best time</span>
          <span>Action</span>
        </div>
        {leads.map((lead) => (
          <div className="lead-table-row" key={lead.id} role="row">
            <strong>{lead.name}</strong>
            <span>{lead.phoneNumber}</span>
            <span>{lead.status === "ready" ? "Now" : lead.status}</span>
            <button
              className="pill-action"
              disabled={pending || lead.status !== "ready" || !canStartCalls}
              onClick={() => onCallLead(lead)}
              type="button"
            >
              Call
            </button>
          </div>
        ))}
        {!leads.length && (
          <div className="lead-table-empty" role="row">
            No leads are queued for this campaign.
          </div>
        )}
      </div>
    </article>
  );
}

function AgentStatusPanel({
  desk,
  mode,
  onCampaignChange,
  onOpenManual,
  softphone
}: {
  desk: AgentDeskWithCampaign;
  mode: "ready" | "active";
  onCampaignChange: (campaignId: string) => Promise<void>;
  onOpenManual: () => void;
  softphone: SoftphoneRuntime;
}) {
  const [campaignPending, setCampaignPending] = useState(false);
  const [campaignError, setCampaignError] = useState<string | null>(null);

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

  return (
    <article className="panel agent-status-panel">
      <div className="surface-heading">
        <h2>Agent status</h2>
      </div>
      <label className="campaign-selector">
        Campaign
        <select
          disabled={campaignPending || mode === "active" || desk.availableCampaigns.length <= 1}
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
      {campaignError && <p className="form-error">{campaignError}</p>}
      <div className="status-stack">
        <StatusBadge label={mode === "active" ? "In call" : "Ready"} tone="good" />
        <StatusBadge
          label={desk.campaign.manualDialingEnabled ? "Manual dialing enabled" : "Manual dialing disabled"}
          tone={desk.campaign.manualDialingEnabled ? "good" : "neutral"}
        />
      </div>
      <div className="softphone-runtime-card">
        <div className="softphone-runtime-icon">
          <Mic size={17} />
        </div>
        <div>
          <strong>{softphone.label}</strong>
          <span>{softphone.error ?? softphone.detail}</span>
        </div>
      </div>
      <div className="softphone-actions">
        {softphone.callState === "active" && (
          <button className="danger-action compact-action" onClick={() => void softphone.hangUpSoftphoneCall()} type="button">
            <PhoneOff size={16} />
            Hang up
          </button>
        )}
      </div>
      {desk.campaign.manualDialingEnabled && (
        <button className="secondary-action manual-open-action" onClick={onOpenManual} type="button">
          <Phone size={17} />
          Manual dialing
        </button>
      )}
      <div className="status-metric-list">
        <Metric label="Callable leads" value={desk.campaign.callableLeads} icon={Users} />
        <Metric label="Calls today" value={desk.metrics.todayCalls} icon={PhoneForwarded} />
        <Metric label="Blocked numbers" value={desk.metrics.suppressed} icon={Ban} />
      </div>
    </article>
  );
}

function AgentNoCampaignStatus({ desk, softphone }: { desk: AgentDeskResponse; softphone: SoftphoneRuntime }) {
  return (
    <article className="panel agent-status-panel">
      <div className="surface-heading">
        <h2>Agent status</h2>
      </div>
      <div className="status-stack">
        <StatusBadge label={desk.activeCall ? "In call" : "No campaign"} tone={desk.activeCall ? "good" : "neutral"} />
        <StatusBadge label="Manual dialing unavailable" tone="neutral" />
      </div>
      <div className="softphone-runtime-card">
        <div className="softphone-runtime-icon">
          <Mic size={17} />
        </div>
        <div>
          <strong>{softphone.label}</strong>
          <span>{softphone.error ?? softphone.detail}</span>
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

function ManualDialSurface({
  desk,
  onDeskChanged,
  onOpenQueue,
  onPhoneNumberChange,
  phoneNumber,
  softphone
}: {
  desk: AgentDeskWithCampaign;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onOpenQueue: () => void;
  onPhoneNumberChange: (phoneNumber: string) => void;
  phoneNumber: string;
  softphone: SoftphoneRuntime;
}) {
  const [result, setResult] = useState<ManualDialValidationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [startPending, setStartPending] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [phoneNumber]);

  async function validate(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setPending(true);
    setError(null);
    try {
      setResult(await validateManualDial(phoneNumber, desk.campaign.id));
    } catch (validateError) {
      setError(validateError instanceof Error ? validateError.message : "Could not validate number");
    } finally {
      setPending(false);
    }
  }

  async function startCall() {
    if (!softphone.registered) {
      setError("Softphone must be registered before starting a call");
      return;
    }
    setStartPending(true);
    setError(null);
    try {
      onDeskChanged(await startManualCall({ campaignId: desk.campaign.id, phoneNumber }));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Could not start call");
    } finally {
      setStartPending(false);
    }
  }

  function pressKey(key: string) {
    onPhoneNumberChange(`${phoneNumber}${key}`);
  }

  const checks = result?.checks ?? [
    { label: "Number format", status: "warn" as const, detail: "Check number before dialing" },
    { label: "Blocked list", status: "warn" as const, detail: "Not checked yet" },
    {
      label: "Campaign permission",
      status: desk.campaign.manualDialingEnabled ? ("pass" as const) : ("fail" as const),
      detail: desk.campaign.manualDialingEnabled ? "Manual dialing allowed" : "Manual dialing disabled"
    }
  ];

  return (
    <section className="manual-dial-grid">
      <article className="panel manual-dial-panel">
        <div className="surface-heading">
          <h2>Manual dialing</h2>
          <p>Use this only when campaign rules allow it. The app checks blocked numbers before dialing.</p>
        </div>
        <form className="manual-dial-form" onSubmit={validate}>
          <label>
            Phone number
            <input
              onChange={(event) => onPhoneNumberChange(event.target.value)}
              placeholder="+1 415 555 0000"
              value={phoneNumber}
            />
          </label>
          <div className="large-keypad" aria-label="Dial pad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((key) => (
              <button key={key} onClick={() => pressKey(key)} type="button">
                {key}
              </button>
            ))}
          </div>
          <div className="manual-dial-actions">
            <button className="secondary-action" disabled={pending || !phoneNumber.trim()} type="submit">
              <CheckCircle2 size={17} />
              {pending ? "Checking" : "Check number"}
            </button>
            <button
              className="primary-action teal-action"
              disabled={
                startPending ||
                !phoneNumber.trim() ||
                !softphone.registered ||
                !desk.campaign.manualDialingEnabled ||
                result?.allowed === false
              }
              onClick={startCall}
              type="button"
            >
              <PhoneCall size={17} />
              {startPending ? "Starting" : "Start call"}
            </button>
            <button className="icon-button" onClick={onOpenQueue} title="Back to queue" type="button">
              <Users size={17} />
            </button>
          </div>
        </form>
      </article>
      <article className="panel pre-call-panel">
        <div className="surface-heading">
          <h2>Pre-call checks</h2>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="check-list">
          {checks.map((check) => (
            <CheckRow detail={check.detail} key={check.label} label={check.label} status={check.status} />
          ))}
          <CheckRow detail="Campaign default" label="Recording default" status="pass" value="Solar Intro v3" />
          <CheckRow
            detail={desk.campaign.callRecordingEnabled ? "On for this campaign" : "Off for this campaign"}
            label="Call recording"
            status={desk.campaign.callRecordingEnabled ? "pass" : "warn"}
          />
        </div>
        <div className="manual-warning">
          <AlertTriangle size={18} />
          <div>
            <strong>Admin-controlled feature</strong>
            <p>If manual dialing is disabled, this screen is hidden and agents can only call imported campaign leads.</p>
          </div>
        </div>
      </article>
    </section>
  );
}

function CheckRow({
  detail,
  label,
  status,
  value
}: {
  detail: string;
  label: string;
  status: "pass" | "warn" | "fail";
  value?: string;
}) {
  const badgeLabel = value ?? (status === "pass" ? "Valid" : status === "warn" ? "Review" : "Blocked");
  return (
    <div className="check-row">
      <span className={`check-badge ${status}`}>{badgeLabel}</span>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function ActiveCall({
  desk,
  dropPending,
  dtmfPending,
  error,
  onDropVoicemail,
  onHangUp,
  onSendDtmf,
  pending
}: {
  desk: AgentDeskResponse;
  dropPending: boolean;
  dtmfPending: boolean;
  error: string | null;
  onDropVoicemail: (callId: string, recordingId?: string) => Promise<void>;
  onHangUp: (callId: string) => Promise<void>;
  onSendDtmf: (callId: string, digit: string) => Promise<void>;
  pending: boolean;
}) {
  const activeCall = desk.activeCall;
  const defaultRecordingId = activeCall?.recordingId ?? desk.recordings[0]?.id ?? "";
  const [selectedRecordingId, setSelectedRecordingId] = useState(defaultRecordingId);
  useEffect(() => {
    setSelectedRecordingId(defaultRecordingId);
  }, [activeCall?.id, defaultRecordingId]);

  if (!activeCall) {
    return (
      <article className="panel active-call">
        <PanelHeader icon={Phone} title="Active call" meta="Ready" />
        {error && <p className="form-error">{error}</p>}
      </article>
    );
  }

  const durationLabel = activeCall.status === "bridged" ? "connected" : activeCall.status;
  const voicemailSignal = formatVoicemailSignal(activeCall.voicemailSignal);
  const selectedRecording = desk.recordings.find((recording) => recording.id === selectedRecordingId);
  const dropRecordingId = selectedRecording?.id ?? activeCall.recordingId ?? undefined;
  return (
    <article className="panel active-call">
      <PanelHeader icon={PhoneCall} title="Active call" meta={activeCall.status} />
      <div className="call-hero">
        <div>
          <h2>{activeCall.leadName}</h2>
          <p>{activeCall.phoneNumber}</p>
        </div>
        <span>
          {activeCall.durationSeconds}s {durationLabel}
        </span>
      </div>
      <div className="call-actions">
        <button className="danger-action" disabled={pending} onClick={() => onHangUp(activeCall.id)} type="button">
          <PhoneOff size={17} />
          {pending ? "Ending" : "Hang up"}
        </button>
        <button
          className="primary-action"
          disabled={pending || dropPending || !dropRecordingId}
          onClick={() => onDropVoicemail(activeCall.id, dropRecordingId)}
          type="button"
        >
          <Voicemail size={17} />
          {dropPending ? "Dropping" : "Drop voicemail"}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="dtmf-panel">
        <div className="dtmf-pad" aria-label="DTMF keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((digit) => (
            <button disabled={dtmfPending} key={digit} onClick={() => void onSendDtmf(activeCall.id, digit)} type="button">
              {digit}
            </button>
          ))}
        </div>
      </div>
      <div className="signal-strip">
        <div className={`voicemail-signal ${activeCall.voicemailSignal}`}>
          <span>VM/beep signal</span>
          <strong>{voicemailSignal.label}</strong>
          <small>{voicemailSignal.detail}</small>
        </div>
        <div>
          <span>Recording</span>
          <label className="compact-select">
            <select
              disabled={pending || dropPending || desk.recordings.length === 0}
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
  user,
  view
}: {
  admin: AdminOverviewResponse | null;
  csvImports: CsvImportSummary[];
  onChanged: () => Promise<void>;
  onManualDial: (phoneNumber: string) => void;
  user: PublicUser;
  view: View;
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
    campaigns: <Campaigns admin={admin} csvImports={csvImports} onChanged={onChanged} onManualDial={onManualDial} />,
    recordings: <Recordings admin={admin} onChanged={onChanged} />,
    history: <HistoryView admin={admin} />,
    settings: <SettingsView admin={admin} onChanged={onChanged} />,
    desk: null
  }[view];

  return <section className="operations-view">{content}</section>;
}

function Campaigns({
  admin,
  csvImports,
  onChanged,
  onManualDial
}: {
  admin: AdminOverviewResponse;
  csvImports: CsvImportSummary[];
  onChanged: () => Promise<void>;
  onManualDial: (phoneNumber: string) => void;
}) {
  return (
    <>
      <div className="operations-grid two">
        <CreateCampaignForm onChanged={onChanged} />
        <CreateContactForm campaigns={admin.campaigns} onChanged={onChanged} />
      </div>
      <div className="operations-grid two">
        <CsvImportForm campaigns={admin.campaigns} onChanged={onChanged} />
        <CsvImportHistory imports={csvImports} />
      </div>
      <div className="operations-grid">
        {admin.campaigns.map((campaign) => (
          <CampaignCard campaign={campaign} key={campaign.id} onChanged={onChanged} />
        ))}
      </div>
      <CampaignContacts campaigns={admin.campaigns} onChanged={onChanged} onManualDial={onManualDial} />
    </>
  );
}

function getValidCampaignId(
  campaignId: string,
  campaigns: AdminOverviewResponse["campaigns"]
): string {
  if (campaigns.some((campaign) => campaign.id === campaignId)) {
    return campaignId;
  }
  return campaigns[0]?.id ?? "";
}

function CampaignCard({
  campaign,
  onChanged
}: {
  campaign: AdminOverviewResponse["campaigns"][number];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [status, setStatus] = useState(campaign.status);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(campaign.name);
    setStatus(campaign.status);
  }, [campaign.name, campaign.status]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await updateCampaign(campaign.id, { name, status });
      setEditing(false);
      await onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not update campaign");
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete campaign "${campaign.name}"?`)) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await deleteCampaign(campaign.id);
      await onChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete campaign");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-header action-header">
        <div>
          <Upload size={18} />
          <h2>{campaign.name}</h2>
        </div>
        <div className="row-actions">
          <button
            className="icon-button"
            disabled={pending}
            onClick={() => setEditing((current) => !current)}
            title={editing ? "Cancel edit" : "Edit campaign"}
            type="button"
          >
            {editing ? <XCircle size={16} /> : <Pencil size={16} />}
          </button>
          <button className="icon-button danger-icon" disabled={pending} onClick={remove} title="Delete campaign" type="button">
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      {editing ? (
        <form className="campaign-edit-form" onSubmit={save}>
          <label>
            Name
            <input onChange={(event) => setName(event.target.value)} required value={name} />
          </label>
          <label>
            Status
            <select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
              <option value="draft">draft</option>
              <option value="active">active</option>
              <option value="paused">paused</option>
            </select>
          </label>
          <button className="primary-action compact-action" disabled={pending} type="submit">
            <CheckCircle2 size={16} />
            {pending ? "Saving" : "Save"}
          </button>
        </form>
      ) : (
        <StatusBadge label={campaign.status} tone="neutral" />
      )}
      <div className="stat-row campaign-stat-row">
        <Metric label="Loaded" value={campaign.loaded} icon={Users} />
        <Metric label="Callable" value={campaign.callable} icon={PhoneCall} />
      </div>
      {error && <p className="form-error">{error}</p>}
    </article>
  );
}

function CampaignContacts({
  campaigns,
  onChanged,
  onManualDial
}: {
  campaigns: AdminOverviewResponse["campaigns"];
  onChanged: () => Promise<void>;
  onManualDial: (phoneNumber: string) => void;
}) {
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "ready" | "suppressed" | "completed">("all");
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
      fetchCampaignContacts(campaignId, { q: query, status })
        .then((nextContacts) => {
          if (requestId === contactsRequestRef.current) {
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
  }, [campaignId, query, reloadKey, status]);

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
      <PanelHeader icon={Users} title="Campaign contacts" meta={pending ? "loading" : `${contacts?.total ?? 0} found`} />
      <div className="contact-toolbar">
        <label>
          Campaign
          <select
            disabled={!campaigns.length}
            onChange={(event) => setCampaignId(event.target.value)}
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
          <input onChange={(event) => setQuery(event.target.value)} placeholder="Name, phone, company" value={query} />
        </label>
        <label>
          Status
          <select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
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
            <span>{contact.company}</span>
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
    </article>
  );
}

function CsvImportForm({
  campaigns,
  onChanged
}: {
  campaigns: AdminOverviewResponse["campaigns"];
  onChanged: () => Promise<void>;
}) {
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
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
      <PanelHeader icon={Upload} title="CSV import" meta="Bulk" />
      <form className="stack-form" onSubmit={submit}>
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
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            type="file"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        {result && (
          <div className="import-result">
            <strong>{result.importedRows} imported</strong>
            <span>
              {result.failedRows} failed from {result.totalRows} rows
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

function CsvImportHistory({ imports }: { imports: CsvImportSummary[] }) {
  const [selected, setSelected] = useState<CsvImportDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function selectImport(importId: string) {
    setPendingId(importId);
    setError(null);
    try {
      setSelected(await fetchCsvImportDetail(importId));
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "Could not load import detail");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <article className="panel">
      <PanelHeader icon={History} title="Recent imports" meta={`${imports.length} runs`} />
      <div className="table-list">
        {imports.length === 0 && <div className="empty-row">No imports yet</div>}
        {imports.map((item) => (
          <button className="table-row import-row clickable-row" key={item.id} onClick={() => selectImport(item.id)} type="button">
            <strong>{item.filename}</strong>
            <span>{item.campaignName}</span>
            <span>
              {item.importedRows}/{item.totalRows}
            </span>
            <b>{pendingId === item.id ? "loading" : item.status}</b>
          </button>
        ))}
      </div>
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
        </div>
      )}
    </article>
  );
}

function CreateCampaignForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"active" | "paused" | "draft">("draft");
  const [manualDialingEnabled, setManualDialingEnabled] = useState(true);
  const [callRecordingEnabled, setCallRecordingEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createCampaign({ name, status, manualDialingEnabled, callRecordingEnabled });
      setName("");
      setStatus("draft");
      await onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not create campaign");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="panel form-panel">
      <PanelHeader icon={Upload} title="New campaign" meta="Create" />
      <form className="stack-form" onSubmit={submit}>
        <label>
          Name
          <input onChange={(event) => setName(event.target.value)} placeholder="Solar Follow-up" required value={name} />
        </label>
        <label>
          Status
          <select onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
            <option value="draft">draft</option>
            <option value="active">active</option>
            <option value="paused">paused</option>
          </select>
        </label>
        <div className="toggle-row">
          <label>
            <input
              checked={manualDialingEnabled}
              onChange={(event) => setManualDialingEnabled(event.target.checked)}
              type="checkbox"
            />
            Manual dialing
          </label>
          <label>
            <input
              checked={callRecordingEnabled}
              onChange={(event) => setCallRecordingEnabled(event.target.checked)}
              type="checkbox"
            />
            Call recording
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-action" disabled={pending} type="submit">
          <Upload size={17} />
          {pending ? "Creating" : "Create campaign"}
        </button>
      </form>
    </article>
  );
}

function CreateContactForm({
  campaigns,
  onChanged
}: {
  campaigns: AdminOverviewResponse["campaigns"];
  onChanged: () => Promise<void>;
}) {
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const nextCampaignId = getValidCampaignId(campaignId, campaigns);
    if (nextCampaignId !== campaignId) {
      setCampaignId(nextCampaignId);
    }
  }, [campaignId, campaigns]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createContact({ campaignId, name, company: company || undefined, phoneNumber });
      setName("");
      setCompany("");
      setPhoneNumber("");
      await onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not add lead");
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="panel form-panel">
      <PanelHeader icon={Users} title="Add lead" meta="Queue" />
      <form className="stack-form" onSubmit={submit}>
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
          Name
          <input onChange={(event) => setName(event.target.value)} placeholder="Avery Johnson" required value={name} />
        </label>
        <label>
          Phone
          <input
            onChange={(event) => setPhoneNumber(event.target.value)}
            placeholder="+1 415 555 0148"
            required
            value={phoneNumber}
          />
        </label>
        <label>
          Company
          <input onChange={(event) => setCompany(event.target.value)} placeholder="North Bay Solar" value={company} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-action" disabled={pending || !campaigns.length} type="submit">
          <Users size={17} />
          {pending ? "Adding" : "Add lead"}
        </button>
      </form>
    </article>
  );
}

function Recordings({ admin, onChanged }: { admin: AdminOverviewResponse; onChanged: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);
  const [pending, setPending] = useState(false);
  const [defaultPendingId, setDefaultPendingId] = useState<string | null>(null);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!preview) {
      return;
    }
    previewAudioRef.current?.play().catch(() => undefined);
  }, [preview]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!file) {
      setError("Choose a WAV or MP3 file");
      return;
    }

    setPending(true);
    setError(null);
    try {
      await uploadRecording({
        file,
        name: name.trim() || file.name.replace(/\.[^.]+$/, ""),
        makeDefault
      });
      setFile(null);
      setName("");
      setMakeDefault(true);
      form.reset();
      await onChanged();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Unable to upload recording");
    } finally {
      setPending(false);
    }
  }

  async function makeRecordingDefault(recordingId: string) {
    setDefaultPendingId(recordingId);
    setError(null);
    try {
      await setDefaultRecording(recordingId);
      await onChanged();
    } catch (defaultError) {
      setError(defaultError instanceof Error ? defaultError.message : "Unable to set default recording");
    } finally {
      setDefaultPendingId(null);
    }
  }

  async function removeRecording(recording: AdminOverviewResponse["recordings"][number]) {
    if (!window.confirm(`Delete ${recording.name}?`)) {
      return;
    }

    setDeletePendingId(recording.id);
    setError(null);
    try {
      await deleteRecording(recording.id);
      await onChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete recording");
    } finally {
      setDeletePendingId(null);
    }
  }

  function togglePreview(recordingId: string) {
    if (preview?.id === recordingId) {
      setPreview(null);
      return;
    }

    setError(null);
    const url = getRecordingAudioUrl(recordingId);
    if (!url) {
      setError("Sign in again to preview voicemail");
      return;
    }
    setPreview({ id: recordingId, url });
  }

  return (
    <>
      <article className="panel form-panel">
        <PanelHeader icon={Upload} title="Upload voicemail" meta="WAV or MP3" />
        <form className="stack-form" onSubmit={submit}>
          <label>
            Voicemail file
            <input
              accept=".wav,.mp3,audio/wav,audio/mpeg"
              onChange={(event) => {
                const nextFile = event.target.files?.[0] ?? null;
                setFile(nextFile);
                if (nextFile && !name.trim()) {
                  setName(nextFile.name.replace(/\.[^.]+$/, ""));
                }
              }}
              required
              type="file"
            />
          </label>
          <label>
            Voicemail name
            <input onChange={(event) => setName(event.target.value)} placeholder="Solar Intro v3" value={name} />
          </label>
          <div className="toggle-row">
            <label>
              <input checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} type="checkbox" />
              Make default
            </label>
          </div>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-action" disabled={pending || !file} type="submit">
            <Upload size={17} />
            {pending ? "Uploading" : "Upload voicemail"}
          </button>
        </form>
      </article>
      <article className="panel wide-panel">
        <PanelHeader icon={FileAudio} title="Voicemail recordings" meta={`${admin.recordings.length} files`} />
        <div className="table-list">
          {admin.recordings.map((recording) => (
            <div className="recording-item" key={recording.id}>
              <div className="table-row recording-row">
                <div>
                  <strong>{recording.name}</strong>
                  <small>{recording.runtimeFilePath}</small>
                </div>
                <span>
                  {recording.durationSeconds ? `${recording.durationSeconds}s` : "Duration pending"} ·{" "}
                  {formatBytes(recording.fileSizeBytes)}
                </span>
                <b>{recording.status}</b>
                <button
                  className="icon-button"
                  disabled={deletePendingId === recording.id}
                  onClick={() => togglePreview(recording.id)}
                  title={preview?.id === recording.id ? "Stop preview" : "Preview voicemail"}
                  type="button"
                >
                  {preview?.id === recording.id ? <Square size={16} /> : <Play size={16} />}
                </button>
                <button
                  className="secondary-action compact-action"
                  disabled={
                    recording.status === "default" ||
                    defaultPendingId === recording.id ||
                    deletePendingId === recording.id
                  }
                  onClick={() => void makeRecordingDefault(recording.id)}
                  type="button"
                >
                  <CheckCircle2 size={16} />
                  {defaultPendingId === recording.id ? "Saving" : "Default"}
                </button>
                <button
                  className="icon-button danger-icon"
                  disabled={deletePendingId === recording.id || defaultPendingId === recording.id}
                  onClick={() => void removeRecording(recording)}
                  title="Delete voicemail"
                  type="button"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {preview?.id === recording.id && (
                <audio
                  autoPlay
                  className="recording-preview"
                  controls
                  ref={previewAudioRef}
                  src={preview.url}
                />
              )}
            </div>
          ))}
          {!admin.recordings.length && <p className="empty-state">No voicemail recordings uploaded yet.</p>}
        </div>
      </article>
    </>
  );
}

function formatBytes(value: number): string {
  if (value <= 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const kilobytes = value / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(kilobytes < 10 ? 1 : 0)} KB`;
  }
  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
}

function UsersPanel({ onChanged, users }: { onChanged: () => Promise<void>; users: PublicUser[] }) {
  return (
    <article className="panel users-panel">
      <PanelHeader icon={Users} title="Users" meta={`${users.length} seats`} />
      <CreateUserForm onChanged={onChanged} />
      <UserList onChanged={onChanged} users={users} />
    </article>
  );
}

function UserList({ onChanged, users }: { onChanged: () => Promise<void>; users: PublicUser[] }) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(user: PublicUser) {
    if (!window.confirm(`Delete ${user.name}?`)) {
      return;
    }
    setPendingId(user.id);
    setError(null);
    try {
      await deleteUser(user.id);
      await onChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete user");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="table-list">
      {error && <p className="form-error">{error}</p>}
      {users.map((user) => (
        <div className="table-row user-row" key={user.id}>
          <strong>{user.name}</strong>
          <span>{user.email}</span>
          <b>{user.role}</b>
          <button
            className="icon-button danger-icon"
            disabled={pendingId === user.id}
            onClick={() => remove(user)}
            title="Delete user"
            type="button"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

function CreateUserForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"agent" | "admin">("agent");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setCredentials(null);
    try {
      const created = await createUser({ email, name, role, password });
      if (created.agentCredentials) {
        setCredentials(`${created.agentCredentials.sipUsername} / ${created.agentCredentials.sipPassword}`);
      }
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
          <input onChange={(event) => setName(event.target.value)} placeholder="Agent name" required value={name} />
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
        <input onChange={(event) => setEmail(event.target.value)} placeholder="agent@example.com" required type="email" value={email} />
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
      {credentials && <p className="copy-note">SIP: {credentials}</p>}
      <button className="primary-action" disabled={pending} type="submit">
        <UserPlus size={17} />
        {pending ? "Creating" : "Create user"}
      </button>
    </form>
  );
}

function HistoryView({ admin }: { admin: AdminOverviewResponse }) {
  return (
    <article className="panel wide-panel">
      <PanelHeader icon={History} title="Call history" meta={`${admin.callHistory.length} recent`} />
      <div className="table-list">
        {admin.callHistory.map((call) => (
          <div className="table-row history-row" key={call.id}>
            <strong>{call.leadName}</strong>
            <span>{call.agentName}</span>
            <span>{call.durationSeconds}s</span>
            <span title={call.callRecordingPath ?? undefined}>
              {call.callRecordingPath ? "Recording saved" : "No recording"}
            </span>
            <b>{call.outcome}</b>
          </div>
        ))}
      </div>
    </article>
  );
}

function SettingsView({ admin, onChanged }: { admin: AdminOverviewResponse; onChanged: () => Promise<void> }) {
  return (
    <div className="operations-grid two">
      <FreeSwitchDiagnosticsPanel />
      <article className="panel">
        <PanelHeader icon={Ban} title="Suppression" meta={`${admin.suppression.length} entries`} />
        <div className="table-list">
          {admin.suppression.map((item) => (
            <SuppressionRow item={item} key={item.id} onChanged={onChanged} />
          ))}
          {admin.suppression.length === 0 && <div className="empty-row">No suppressed numbers</div>}
        </div>
      </article>
      <CreateSuppressionForm onChanged={onChanged} />
      <article className="panel">
        <PanelHeader icon={Activity} title="Operations" meta="Today" />
        <div className="stat-row">
          <Metric label="Active agents" value={admin.stats.activeAgents} icon={Headphones} />
          <Metric label="Live calls" value={admin.stats.liveCalls} icon={PhoneCall} />
        </div>
      </article>
      <UsersPanel onChanged={onChanged} users={admin.users} />
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
        <button className="icon-button danger-icon" disabled={pending} onClick={remove} title="Remove suppression" type="button">
          <Trash2 size={16} />
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </>
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
          <StatusBadge label={diagnostics.trunk.proxyConfigured ? "Proxy set" : "Proxy missing"} tone={diagnostics.trunk.proxyConfigured ? "good" : "bad"} />
          <StatusBadge label={diagnostics.trunk.usernameConfigured ? "User set" : "User missing"} tone={diagnostics.trunk.mode === "ip_auth" || diagnostics.trunk.usernameConfigured ? "good" : "bad"} />
          <StatusBadge label={diagnostics.trunk.callerIdConfigured ? "Caller ID set" : "Caller ID missing"} tone={diagnostics.trunk.callerIdConfigured ? "good" : "neutral"} />
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
          <input onChange={(event) => setReason(event.target.value)} placeholder="Do not call request" value={reason} />
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

function PanelHeader({
  icon: Icon,
  meta,
  title
}: {
  icon: typeof BarChart3;
  meta: string;
  title: string;
}) {
  return (
    <div className="panel-header">
      <div>
        <Icon size={18} />
        <h2>{title}</h2>
      </div>
      <span>{meta}</span>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value
}: {
  icon: typeof BarChart3;
  label: string;
  value: number;
}) {
  return (
    <div className="metric-card">
      <Icon size={17} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: "good" | "bad" | "neutral" }) {
  return (
    <span className={`status-badge ${tone}`}>
      <Clock3 size={14} />
      {label}
    </span>
  );
}
