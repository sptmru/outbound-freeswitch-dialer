import type { LucideIcon } from "lucide-react";

export function PanelHeader({ icon: Icon, meta, title }: { icon: LucideIcon; meta: string; title: string }) {
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

export function Metric({
  icon: Icon,
  label,
  value
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
}) {
  return (
    <div className="metric-card">
      <Icon size={17} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function StatusBadge({ label, tone }: { label: string; tone: "good" | "bad" | "neutral" | "warn" }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}
