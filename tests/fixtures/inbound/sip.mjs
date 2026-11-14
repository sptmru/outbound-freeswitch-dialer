// Reuse the A04 Digest REGISTER/SDP/RTP client inside its --network none lab.
import assert from "node:assert/strict";
import { sipClient } from "../../../scripts/a04-sip-client.mjs";

export function localSipClient(options) {
  assert.match(
    options.source,
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/,
    "Local SIP fixture requires loopback source"
  );
  return sipClient(options);
}
