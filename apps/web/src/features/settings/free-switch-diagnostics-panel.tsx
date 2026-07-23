import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Radio, XCircle } from "lucide-react";
import { fetchFreeSwitchDiagnostics, runFreeSwitchSafeTest } from "../../api";
import { PanelHeader, StatusBadge } from "../../components/ui-primitives";
import type { FreeSwitchDiagnosticsResponse, FreeSwitchSafeTestResponse } from "../../types";

export function FreeSwitchDiagnosticsPanel() {
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
