// Vite replaces only App's phone hook. Desk controls and API calls remain product code.
import { useEffect, useState } from "react";
import { fetchAgentDesk } from "../../../apps/web/src/api";
import { readyPhone } from "../../../apps/web/src/test/coordination-fixtures";
import type { AgentDeskResponse, PublicUser } from "../../../apps/web/src/types";

export function useSoftphoneRegistration(
  user: PublicUser | null,
  control?: { campaignId: string | null; expectedRevision: string | null }
) {
  const [desk, setDesk] = useState<AgentDeskResponse | null>(null);
  useEffect(() => {
    if (!user || !control) return;
    let active = true;
    void fetchAgentDesk(control.campaignId ?? undefined).then(
      (snapshot) => {
        if (active) setDesk(snapshot);
      },
      () => {
        if (active) setDesk(null);
      }
    );
    return () => {
      active = false;
    };
  }, [user?.id, control?.campaignId, control?.expectedRevision]);
  const snapshot = desk?.user.id === user?.id ? desk : null;
  const phone = readyPhone(snapshot ?? ({ coordination: { session: null } } as AgentDeskResponse));
  phone.registered = Boolean(snapshot?.coordination?.session?.ready);
  return phone;
}
