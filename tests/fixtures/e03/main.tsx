// Test-only Vite entry. Real AgentDesk/API client; simulated controller and media.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentDesk } from "../../../apps/web/src/features/agent-desk/agent-desk";
import { olderDesk } from "../../../apps/web/src/features/agent-desk/coordination";
import { readyPhone } from "../../../apps/web/src/test/coordination-fixtures";
import { fetchAgentDesk } from "../../../apps/web/src/api";
import type { AgentDeskResponse } from "../../../apps/web/src/types";
import "../../../apps/web/src/styles.css";

declare global {
  interface Window {
    e03: { snapshot(desk: AgentDeskResponse): void; refresh(): Promise<void>; ringback: number };
    e03Sound: { plays: number; pauses: number; denied: boolean };
  }
}
function Fixture() {
  const [desk, setDesk] = useState<AgentDeskResponse | null>(null);
  const [number, setNumber] = useState("+15557654321");
  const [open, setOpen] = useState(true);
  const commit = (next: AgentDeskResponse) =>
    setDesk((current) => (olderDesk(next, current) ? current : next));
  useEffect(() => {
    window.e03 = { snapshot: commit, refresh: async () => commit(await fetchAgentDesk()), ringback: 0 };
    void window.e03.refresh();
  }, []);
  const phone = desk ? readyPhone(desk) : null;
  if (phone)
    phone.startBrowserRingback = () => {
      window.e03.ringback++;
    };
  return (
    <>
      <p>E03 fixture: simulated API, controller and media; no SIP/WebRTC/provider proof.</p>
      <button onClick={() => setOpen(!open)}>Toggle Desk</button>
      <button onClick={() => void window.e03.refresh()}>Refresh snapshot</button>
      {open && desk && phone && (
        <AgentDesk
          desk={desk}
          manualDialNumber={number}
          onManualDialNumberChange={setNumber}
          onDeskChanged={commit}
          onCampaignChange={async () => undefined}
          softphone={phone}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
