export function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export function formatPercent(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export function formatNullablePercent(value: number | null): string {
  return value === null ? "—" : formatPercent(value);
}

export function formatMilliseconds(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return "<1 ms";
  if (value < 1000) return `${Math.round(value).toLocaleString()} ms`;
  return `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
}

export function formatBrowserMilliseconds(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
