import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPcapDisplayFilter, extractPcapFilterSelection } from "./pcap-filter.js";

describe("per-call PCAP isolation filter", () => {
  it("extracts unique call media ports, RTCP companions, and SIP Call-IDs from ESL events", () => {
    const selection = extractPcapFilterSelection([
      {
        headers: {
          variable_local_media_port: "16420",
          variable_rtp_local_sdp_str: "v=0%0D%0Am=audio%2016420%20RTP%2FAVP%200%0D%0A",
          variable_sip_call_id: "provider-call%40example.net"
        }
      },
      {
        headers: {
          "variable-advertised-media-port": "16440",
          variable_sip_invite_call_id: "agent-call@example.net"
        }
      }
    ]);

    assert.deepEqual(selection.mediaPorts, [16420, 16421, 16440, 16441]);
    assert.deepEqual(selection.sipCallIds, ["agent-call@example.net", "provider-call@example.net"]);
  });

  it("builds a display filter without accepting arbitrary filter syntax", () => {
    const filter = buildPcapDisplayFilter({
      mediaPorts: [16420],
      sipCallIds: ['call-"quoted"@example.net']
    });

    assert.equal(filter, '(udp.port == 16420) or (sip.Call-ID == "call-\\"quoted\\"@example.net")');
    assert.throws(() => buildPcapDisplayFilter({ mediaPorts: [], sipCallIds: [] }), /could not be isolated/);
    assert.throws(() => buildPcapDisplayFilter({ mediaPorts: [0], sipCallIds: [] }), /Invalid media port/);
  });
});
