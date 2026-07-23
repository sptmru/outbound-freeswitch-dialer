import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Headphones, LogOut, PhoneCall, Radio } from "lucide-react";
import { StatusBadge } from "../../components/ui-primitives";
import type { SoftphoneRuntime } from "../../softphone";
import type { AgentDeskResponse, PublicUser } from "../../types";

export type AppView =
  "desk" | "live" | "analytics" | "campaigns" | "recordings" | "history" | "suppression" | "settings";

export function LoginScreen({
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

export function TopBar({
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
  view: AppView;
}) {
  const titles: Record<AppView, { title: string; subtitle: string }> = {
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
