import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Settings2 } from "lucide-react";
import { fetchSystemSettings, updateSystemSettings } from "../../api";
import { PanelHeader } from "../../components/ui-primitives";
import { getErrorMessage } from "../../lib/errors";
import { formatDateTime } from "../../lib/formatters";
import type { AdminSystemSettings, UpdateAdminSystemSettingsRequest } from "../../types";

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

export function SystemSettingsPanel() {
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
