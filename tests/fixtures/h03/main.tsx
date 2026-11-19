import React from "react";
import { createRoot } from "react-dom/client";
import { HistoryView } from "../../../apps/web/src/features/history/history-view";
import type { AdminOverviewResponse } from "../../../apps/web/src/types";
import "../../../apps/web/src/styles.css";
const admin = {
  callHistory: [],
  campaigns: [{ id: "11111111-1111-4111-8111-111111111111", name: "Fixed campaign" }],
  users: [{ id: "22222222-2222-4222-8222-222222222222", name: "Agent B", role: "agent" }]
} as unknown as AdminOverviewResponse;
createRoot(document.getElementById("root")!).render(
  <>
    <p>H03 rendered history fixture: simulated API and persisted history; no SIP/provider proof.</p>
    <HistoryView admin={admin} refreshVersion={0} />
  </>
);
