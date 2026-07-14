export type PcapFilterSelection = {
  mediaPorts: number[];
  sipCallIds: string[];
};

type CallEventRaw = {
  headers?: Record<string, unknown>;
};

const LOCAL_MEDIA_PORT_KEY =
  /(?:^|[_-])(?:(?:local|advertised)[_-](?:media|rtp)[_-]port|rtp[_-]local[_-]port)$/i;
const LOCAL_SDP_KEY = /(?:^|[_-])(?:local|write)[_-].*sdp/i;
const SIP_CALL_ID_KEY = /(?:^|[_-])sip(?:[_-]invite)?[_-]call[_-]id$/i;

export function extractPcapFilterSelection(rawEvents: unknown[]): PcapFilterSelection {
  const mediaPorts = new Set<number>();
  const sipCallIds = new Set<string>();

  for (const rawEvent of rawEvents) {
    const headers = eventHeaders(rawEvent);
    for (const [key, rawValue] of Object.entries(headers)) {
      if (typeof rawValue !== "string") continue;
      const value = decodeHeaderValue(rawValue).trim();

      if (LOCAL_MEDIA_PORT_KEY.test(key)) {
        addMediaPort(mediaPorts, value);
      }
      if (LOCAL_SDP_KEY.test(key)) {
        for (const match of value.matchAll(/(?:^|\r?\n)m=audio\s+(\d{1,5})\b/gim)) {
          addMediaPort(mediaPorts, match[1]);
        }
      }
      if (SIP_CALL_ID_KEY.test(key) && isSafeSipCallId(value)) {
        sipCallIds.add(value);
      }
    }
  }

  return {
    mediaPorts: [...mediaPorts].sort((left, right) => left - right),
    sipCallIds: [...sipCallIds].sort()
  };
}

export function buildPcapDisplayFilter(selection: PcapFilterSelection): string {
  const clauses = selection.mediaPorts.map((port) => `udp.port == ${validatePort(port)}`);
  clauses.push(
    ...selection.sipCallIds.map((callId) => {
      if (!isSafeSipCallId(callId)) throw new Error("Invalid SIP Call-ID for PCAP filter");
      return `sip.Call-ID == "${escapeDisplayFilterString(callId)}"`;
    })
  );
  if (!clauses.length) {
    throw new Error(
      "PCAP capture could not be isolated because no call media ports or SIP Call-IDs were found"
    );
  }
  return clauses.map((clause) => `(${clause})`).join(" or ");
}

function eventHeaders(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const raw = value as CallEventRaw;
  return raw.headers && typeof raw.headers === "object" ? raw.headers : {};
}

function addMediaPort(ports: Set<number>, value: string): void {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
  ports.add(port);
  // FreeSWITCH normally allocates the adjacent port for RTCP when rtcp-mux is not in use.
  if (port < 65_535) ports.add(port + 1);
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", "%20"));
  } catch {
    return value;
  }
}

function isSafeSipCallId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
  );
}

function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Invalid media port for PCAP filter");
  }
  return value;
}

function escapeDisplayFilterString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
