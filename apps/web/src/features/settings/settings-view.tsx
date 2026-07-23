import { BarChart3, CheckCircle2, Clock3, PhoneCall, Voicemail } from "lucide-react";
import { Metric, PanelHeader } from "../../components/ui-primitives";
import type { AdminOverviewResponse } from "../../types";
import { AdminAuditPanel } from "./admin-audit-panel";
import { FreeSwitchDiagnosticsPanel } from "./free-switch-diagnostics-panel";
import { SystemSettingsPanel } from "./system-settings-panel";
import { UsersPanel } from "./users-panel";

export function SettingsView({
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
