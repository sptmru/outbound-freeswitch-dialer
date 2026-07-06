import { useEffect, useState } from "react";
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
  Phone,
  PhoneCall,
  PhoneForwarded,
  PhoneOff,
  Radio,
  Shield,
  Upload,
  Users,
  Voicemail,
  XCircle
} from "lucide-react";
import {
  clearStoredToken,
  completeContact,
  createCampaign,
  createContact,
  createSuppression,
  endCall,
  fetchAdminOverview,
  fetchCampaignContacts,
  fetchCsvImports,
  fetchCsvImportDetail,
  fetchAgentDesk,
  fetchMe,
  getStoredToken,
  importCampaignCsv,
  importCampaignCsvFile,
  login,
  setStoredToken,
  startLeadCall,
  startManualCall,
  startNextCall,
  suppressContact,
  validateManualDial
} from "./api";
import type {
  AdminOverviewResponse,
  AgentDeskResponse,
  CampaignContactListItem,
  CampaignContactsResponse,
  CsvImportDetailResponse,
  CsvImportSummary,
  ImportCsvResponse,
  LeadSummary,
  ManualDialValidationResponse,
  PublicUser
} from "./types";

type View = "desk" | "campaigns" | "recordings" | "history" | "settings";

const navItems: Array<{ id: View; label: string; icon: typeof BarChart3 }> = [
  { id: "desk", label: "Agent Desk", icon: BarChart3 },
  { id: "campaigns", label: "Campaigns", icon: Upload },
  { id: "recordings", label: "Recordings", icon: FileAudio },
  { id: "history", label: "Call History", icon: History },
  { id: "settings", label: "Settings", icon: Shield }
];

export function App() {
  const [tokenReady, setTokenReady] = useState(false);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [desk, setDesk] = useState<AgentDeskResponse | null>(null);
  const [admin, setAdmin] = useState<AdminOverviewResponse | null>(null);
  const [csvImports, setCsvImports] = useState<CsvImportSummary[]>([]);
  const [view, setView] = useState<View>("desk");
  const [error, setError] = useState<string | null>(null);
  const [manualDialNumber, setManualDialNumber] = useState("");

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setTokenReady(true);
      return;
    }

    void hydrateSession();
  }, []);

  async function hydrateSession() {
    try {
      const [{ user: nextUser }, nextDesk] = await Promise.all([fetchMe(), fetchAgentDesk()]);
      setUser(nextUser);
      setDesk(nextDesk);
      if (nextUser.role === "admin") {
        const [nextAdmin, nextImports] = await Promise.all([fetchAdminOverview(), fetchCsvImports()]);
        setAdmin(nextAdmin);
        setCsvImports(nextImports.imports);
      }
    } catch (sessionError) {
      clearStoredToken();
      setUser(null);
      setDesk(null);
      setAdmin(null);
      setCsvImports([]);
      setError(sessionError instanceof Error ? sessionError.message : "Session expired");
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
    clearStoredToken();
    setUser(null);
    setDesk(null);
    setAdmin(null);
    setCsvImports([]);
    setView("desk");
  }

  if (!tokenReady) {
    return <div className="boot-screen">Loading dialer</div>;
  }

  if (!user || !desk) {
    return <LoginScreen error={error} onLogin={handleLogin} />;
  }

  return (
    <div className="app-shell">
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
                className={item.id === view ? "nav-item active" : "nav-item"}
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
          <span>{desk.campaign.name}</span>
          <strong>{desk.campaign.status}</strong>
        </div>
      </aside>

      <main className="workspace">
        <TopBar desk={desk} user={user} onLogout={handleLogout} />
        {view === "desk" && (
          <AgentDesk
            desk={desk}
            manualDialNumber={manualDialNumber}
            onDeskChanged={setDesk}
            onManualDialNumberChange={setManualDialNumber}
          />
        )}
        {view !== "desk" && (
          <AdminView
            admin={admin}
            csvImports={csvImports}
            onChanged={hydrateSession}
            onManualDial={(phoneNumber) => {
              setManualDialNumber(phoneNumber);
              setView("desk");
            }}
            view={view}
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
  user
}: {
  desk: AgentDeskResponse;
  onLogout: () => void;
  user: PublicUser;
}) {
  return (
    <header className="topbar">
      <div>
        <p>{desk.campaign.name}</p>
        <h1>Agent Desk</h1>
      </div>
      <div className="topbar-actions">
        <StatusBadge
          label={desk.softphone.registered ? "app registered" : "app offline"}
          tone={desk.softphone.registered ? "good" : "bad"}
        />
        <StatusBadge
          label={desk.softphone.microphoneAllowed ? "Mic allowed" : "Mic blocked"}
          tone={desk.softphone.microphoneAllowed ? "good" : "bad"}
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
  onDeskChanged,
  onManualDialNumberChange
}: {
  desk: AgentDeskResponse;
  manualDialNumber: string;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onManualDialNumberChange: (phoneNumber: string) => void;
}) {
  const [deskMode, setDeskMode] = useState<"ready" | "manual">("ready");
  const [callNextPending, setCallNextPending] = useState(false);
  const [callNextError, setCallNextError] = useState<string | null>(null);
  const [endCallPending, setEndCallPending] = useState(false);
  const [endCallError, setEndCallError] = useState<string | null>(null);

  useEffect(() => {
    if (manualDialNumber && !desk.activeCall && desk.campaign.manualDialingEnabled) {
      setDeskMode("manual");
    }
  }, [desk.activeCall, desk.campaign.manualDialingEnabled, manualDialNumber]);

  async function callNext() {
    setCallNextPending(true);
    setCallNextError(null);
    try {
      onDeskChanged(await startNextCall());
    } catch (error) {
      setCallNextError(error instanceof Error ? error.message : "Could not start next call");
    } finally {
      setCallNextPending(false);
    }
  }

  async function callLead(lead: LeadSummary) {
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
      onDeskChanged(await endCall(callId, { outcome: "agent_canceled" }));
    } catch (error) {
      setEndCallError(error instanceof Error ? error.message : "Could not end call");
    } finally {
      setEndCallPending(false);
    }
  }

  if (desk.activeCall) {
    return (
      <section className="agent-grid active-agent-grid">
        <LeadQueue
          error={callNextError}
          leads={desk.leads}
          onCallLead={callLead}
          onCallNext={callNext}
          pending={callNextPending}
        />
        <ActiveCall desk={desk} error={endCallError} onHangUp={hangUp} pending={endCallPending} />
        <AgentStatusPanel desk={desk} mode="active" onOpenManual={() => setDeskMode("manual")} />
      </section>
    );
  }

  if (deskMode === "manual" && desk.campaign.manualDialingEnabled) {
    return (
      <ManualDialSurface
        desk={desk}
        onDeskChanged={onDeskChanged}
        onOpenQueue={() => setDeskMode("ready")}
        onPhoneNumberChange={onManualDialNumberChange}
        phoneNumber={manualDialNumber}
      />
    );
  }

  return (
    <section className="ready-desk-grid">
      <LeadQueue
        error={callNextError}
        leads={desk.leads}
        onCallLead={callLead}
        onCallNext={callNext}
        pending={callNextPending}
      />
      <AgentStatusPanel desk={desk} mode="ready" onOpenManual={() => setDeskMode("manual")} />
    </section>
  );
}

function LeadQueue({
  error,
  leads,
  onCallLead,
  onCallNext,
  pending
}: {
  error: string | null;
  leads: LeadSummary[];
  onCallLead: (lead: LeadSummary) => Promise<void>;
  onCallNext: () => Promise<void>;
  pending: boolean;
}) {
  const recommended = leads.find((lead) => lead.status === "ready") ?? leads[0];

  return (
    <article className="panel lead-queue next-leads-panel">
      <div className="surface-heading">
        <h2>Next leads</h2>
        <p>No live call is active. Start the next call from the campaign queue.</p>
      </div>
      {error && <p className="form-error">{error}</p>}
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
              disabled={pending || lead.status !== "ready"}
              onClick={() => onCallLead(lead)}
              type="button"
            >
              Call
            </button>
          </div>
        ))}
      </div>
      {recommended && (
        <div className="recommended-call">
          <h3>Recommended next: {recommended.name}</h3>
          <p>
            {recommended.company}. Default voicemail: {recommended.fields[0]?.value ?? "campaign default"}.
          </p>
          <button className="primary-action teal-action" disabled={pending} onClick={onCallNext} type="button">
            <PhoneCall size={17} />
            {pending ? "Starting" : "Start next call"}
          </button>
        </div>
      )}
    </article>
  );
}

function AgentStatusPanel({
  desk,
  mode,
  onOpenManual
}: {
  desk: AgentDeskResponse;
  mode: "ready" | "active";
  onOpenManual: () => void;
}) {
  return (
    <article className="panel agent-status-panel">
      <div className="surface-heading">
        <h2>Agent status</h2>
      </div>
      <div className="status-stack">
        <StatusBadge label={mode === "active" ? "In call" : "Ready"} tone="good" />
        <StatusBadge
          label={desk.campaign.manualDialingEnabled ? "Manual dialing enabled" : "Manual dialing disabled"}
          tone={desk.campaign.manualDialingEnabled ? "good" : "neutral"}
        />
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
      {!desk.activeCall && (
        <div className="empty-call-panel">
          <h3>No live call</h3>
          <p>When a call starts, this panel shows timer, lead information, voicemail controls, and call outcome options.</p>
        </div>
      )}
    </article>
  );
}

function ManualDialSurface({
  desk,
  onDeskChanged,
  onOpenQueue,
  onPhoneNumberChange,
  phoneNumber
}: {
  desk: AgentDeskResponse;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onOpenQueue: () => void;
  onPhoneNumberChange: (phoneNumber: string) => void;
  phoneNumber: string;
}) {
  const [note, setNote] = useState("");
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
      setResult(await validateManualDial(phoneNumber));
    } catch (validateError) {
      setError(validateError instanceof Error ? validateError.message : "Could not validate number");
    } finally {
      setPending(false);
    }
  }

  async function startCall() {
    setStartPending(true);
    setError(null);
    try {
      onDeskChanged(await startManualCall({ phoneNumber }));
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
          <label>
            Lead name or note
            <input onChange={(event) => setNote(event.target.value)} placeholder="Optional" value={note} />
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
              disabled={startPending || !phoneNumber.trim()}
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
  error,
  onHangUp,
  pending
}: {
  desk: AgentDeskResponse;
  error: string | null;
  onHangUp: (callId: string) => Promise<void>;
  pending: boolean;
}) {
  const activeCall = desk.activeCall;
  if (!activeCall) {
    return (
      <article className="panel active-call">
        <PanelHeader icon={Phone} title="Active call" meta="Ready" />
        {error && <p className="form-error">{error}</p>}
      </article>
    );
  }

  return (
    <article className="panel active-call">
      <PanelHeader icon={PhoneCall} title="Active call" meta={activeCall.status} />
      <div className="call-hero">
        <div>
          <h2>{activeCall.leadName}</h2>
          <p>{activeCall.phoneNumber}</p>
        </div>
        <span>{activeCall.durationSeconds}s connected</span>
      </div>
      <div className="call-actions">
        <button className="danger-action" disabled={pending} onClick={() => onHangUp(activeCall.id)} type="button">
          <PhoneOff size={17} />
          {pending ? "Ending" : "Hang up"}
        </button>
        <button className="primary-action" type="button">
          <Voicemail size={17} />
          Drop voicemail
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="signal-strip">
        <div>
          <span>VM/beep signal</span>
          <strong>{activeCall.voicemailSignal}</strong>
        </div>
        <div>
          <span>Recording</span>
          <strong>{activeCall.recordingName}</strong>
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

function SoftphonePanel({
  desk,
  manualDialNumber,
  onDeskChanged,
  onManualDialNumberChange
}: {
  desk: AgentDeskResponse;
  manualDialNumber: string;
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onManualDialNumberChange: (phoneNumber: string) => void;
}) {
  return (
    <aside className="softphone-stack">
      <article className="panel">
        <PanelHeader icon={Mic} title="Softphone" meta={desk.softphone.status} />
        <div className="dial-pad">
          <button type="button">1</button>
          <button type="button">2</button>
          <button type="button">3</button>
          <button type="button">4</button>
          <button type="button">5</button>
          <button type="button">6</button>
          <button type="button">7</button>
          <button type="button">8</button>
          <button type="button">9</button>
          <button type="button">*</button>
          <button type="button">0</button>
          <button type="button">#</button>
        </div>
      </article>
      <ManualDial
        onDeskChanged={onDeskChanged}
        phoneNumber={manualDialNumber}
        onPhoneNumberChange={onManualDialNumberChange}
      />
      <article className="metric-grid">
        <Metric label="Today calls" value={desk.metrics.todayCalls} icon={PhoneForwarded} />
        <Metric label="VM dropped" value={desk.metrics.voicemailsDropped} icon={Voicemail} />
        <Metric label="Suppressed" value={desk.metrics.suppressed} icon={Ban} />
      </article>
    </aside>
  );
}

function ManualDial({
  onDeskChanged,
  onPhoneNumberChange,
  phoneNumber
}: {
  onDeskChanged: (desk: AgentDeskResponse) => void;
  onPhoneNumberChange: (phoneNumber: string) => void;
  phoneNumber: string;
}) {
  const [result, setResult] = useState<ManualDialValidationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [startPending, setStartPending] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [phoneNumber]);

  async function validate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      setResult(await validateManualDial(phoneNumber));
    } catch (validateError) {
      setError(validateError instanceof Error ? validateError.message : "Could not validate number");
    } finally {
      setPending(false);
    }
  }

  async function startCall() {
    setStartPending(true);
    setError(null);
    try {
      onDeskChanged(await startManualCall({ phoneNumber }));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Could not start call");
    } finally {
      setStartPending(false);
    }
  }

  return (
    <article className="panel compact-panel">
      <PanelHeader icon={Phone} title="Manual dialing" meta="Preview" />
      <form className="manual-form" onSubmit={validate}>
        <input
          onChange={(event) => onPhoneNumberChange(event.target.value)}
          placeholder="+1 415 555 0199"
          value={phoneNumber}
        />
        <button className="icon-button dark" disabled={pending} title="Validate" type="submit">
          <CheckCircle2 size={17} />
        </button>
        <button
          className="icon-button"
          disabled={startPending || !phoneNumber.trim()}
          onClick={startCall}
          title="Start manual call"
          type="button"
        >
          <PhoneCall size={17} />
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {result && (
        <div className={result.allowed ? "validation-result allowed" : "validation-result blocked"}>
          {result.allowed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <span>{result.reason}</span>
        </div>
      )}
    </article>
  );
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
    recordings: <Recordings admin={admin} />,
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
          <article className="panel" key={campaign.id}>
            <PanelHeader icon={Upload} title={campaign.name} meta={campaign.status} />
            <div className="stat-row">
              <Metric label="Loaded" value={campaign.loaded} icon={Users} />
              <Metric label="Callable" value={campaign.callable} icon={PhoneCall} />
            </div>
          </article>
        ))}
      </div>
      <CampaignContacts campaigns={admin.campaigns} onChanged={onChanged} onManualDial={onManualDial} />
    </>
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

  useEffect(() => {
    if (!campaignId && campaigns[0]?.id) {
      setCampaignId(campaigns[0].id);
    }
  }, [campaignId, campaigns]);

  useEffect(() => {
    if (!campaignId) {
      setContacts(null);
      return;
    }

    const timeout = window.setTimeout(() => {
      setPending(true);
      setError(null);
      fetchCampaignContacts(campaignId, { q: query, status })
        .then(setContacts)
        .catch((loadError: unknown) => {
          setError(loadError instanceof Error ? loadError.message : "Could not load contacts");
        })
        .finally(() => setPending(false));
    }, 180);

    return () => window.clearTimeout(timeout);
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
  const [filename, setFilename] = useState("leads.csv");
  const [csvText, setCsvText] = useState("name,phone,company\nAvery Johnson,+1 415 555 0148,North Bay Solar");
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportCsvResponse | null>(null);

  useEffect(() => {
    if (!campaignId && campaigns[0]?.id) {
      setCampaignId(campaigns[0].id);
    }
  }, [campaignId, campaigns]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const importResult = await importCampaignCsv(campaignId, { filename, csvText });
      setResult(importResult);
      await onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not import CSV");
    } finally {
      setPending(false);
    }
  }

  async function submitFile() {
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
        <div className="inline-fields">
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
            Filename
            <input onChange={(event) => setFilename(event.target.value)} required value={filename} />
          </label>
        </div>
        <label>
          Upload file
          <input
            accept=".csv,text/csv"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            type="file"
          />
        </label>
        <button className="secondary-action" disabled={pending || !campaigns.length || !file} onClick={submitFile} type="button">
          <Upload size={17} />
          {pending ? "Uploading" : "Upload CSV file"}
        </button>
        <label>
          CSV
          <textarea onChange={(event) => setCsvText(event.target.value)} required rows={7} value={csvText} />
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
        <button className="primary-action" disabled={pending || !campaigns.length} type="submit">
          <Upload size={17} />
          {pending ? "Importing" : "Import CSV"}
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
    if (!campaignId && campaigns[0]?.id) {
      setCampaignId(campaigns[0].id);
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

function Recordings({ admin }: { admin: AdminOverviewResponse }) {
  return (
    <div className="operations-grid two">
      <article className="panel">
        <PanelHeader icon={FileAudio} title="Recordings" meta={`${admin.recordings.length} files`} />
        <div className="table-list">
          {admin.recordings.map((recording) => (
            <div className="table-row" key={recording.id}>
              <strong>{recording.name}</strong>
              <span>{recording.durationSeconds}s</span>
              <b>{recording.status}</b>
            </div>
          ))}
        </div>
      </article>
      <article className="panel">
        <PanelHeader icon={Users} title="Users" meta={`${admin.users.length} seats`} />
        <div className="table-list">
          {admin.users.map((agent) => (
            <div className="table-row" key={agent.id}>
              <strong>{agent.name}</strong>
              <span>{agent.email}</span>
              <b>{agent.role}</b>
            </div>
          ))}
        </div>
      </article>
    </div>
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
      <article className="panel">
        <PanelHeader icon={Ban} title="Suppression" meta={`${admin.suppression.length} entries`} />
        <div className="table-list">
          {admin.suppression.map((item) => (
            <div className="table-row" key={item.id}>
              <strong>{item.phoneNumber}</strong>
              <span>{item.reason}</span>
            </div>
          ))}
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
    </div>
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
