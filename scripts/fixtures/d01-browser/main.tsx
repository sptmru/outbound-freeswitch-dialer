// Isolated runtime entry: production hook and HTTP adapter, fixture bootstrap only.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useSoftphoneRegistration } from "../../../apps/web/src/softphone";

const bootstrap = await (await fetch("/fixture/bootstrap")).json();
function Desk() {
  const phone = useSoftphoneRegistration(bootstrap.user, {
    campaignId: bootstrap.campaignId,
    expectedRevision: bootstrap.revision
  });
  Object.assign(window, { d01: phone });
  return (
    <pre>
      {JSON.stringify({
        registered: phone.registered,
        callState: phone.callState,
        audioPlaybackState: phone.audioPlaybackState,
        deskSession: phone.deskSession,
        error: phone.error
      })}
    </pre>
  );
}
function Fixture() {
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button onClick={() => setMounted(false)}>Leave Desk</button>
      {mounted && <Desk />}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
