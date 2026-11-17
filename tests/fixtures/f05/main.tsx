import React from "react";
import { createRoot } from "react-dom/client";
import { InboundAdmin } from "../../../apps/web/src/features/inbound/inbound-admin";
import type { AdminOverviewResponse } from "../../../apps/web/src/types";
import "../../../apps/web/src/styles.css";
const admin = {
  campaigns: [{ id: "campaign", name: "Common campaign", status: "active" }],
  recordings: []
} as unknown as AdminOverviewResponse;
createRoot(document.getElementById("root")!).render(
  <InboundAdmin
    admin={admin}
    role={new URLSearchParams(location.search).has("agent") ? "agent" : "admin"}
    onChanged={async () => {}}
  />
);
