import assert from "node:assert/strict";
import test from "node:test";
import { checkEvidence } from "../scripts/a02-ingress-probe.mjs";

// These test the evidence checker, not FreeSWITCH. Runtime proof is the opt-in lab.
const rejected = () => ({ final: 403, durationMs: 10, rtp: [] });

test("A02 evidence checker rejects forged authority and entry through a rejected DID", () => {
  checkEvidence(rejected(), [], { status: 403 });
  assert.throws(
    () => checkEvidence(rejected(), [{ variable_outbound_dialer_call_id: "forged" }], { status: 403 }),
    /Forged product authority/
  );
  assert.throws(
    () =>
      checkEvidence(rejected(), [{ "event-subclass": "outbound_dialer::a02_validated" }], { status: 403 }),
    /Trust\/DID gate/
  );
});

test("A02 pre-admission proof fails on an answer, bridge, RTP, wrong status or exceeded bound", () => {
  for (const name of ["CHANNEL_ANSWER", "CHANNEL_BRIDGE"]) {
    assert.throws(() => checkEvidence(rejected(), [{ "event-name": name }], { status: 403 }));
  }
  assert.throws(() => checkEvidence({ ...rejected(), rtp: [{}] }, [], { status: 403 }), /emitted RTP/);
  assert.throws(() => checkEvidence({ ...rejected(), durationMs: 4000 }, [], { status: 403 }), /exceeded/);
  assert.throws(() => checkEvidence({ ...rejected(), final: 200 }, [], { status: 403 }));
});

test("A02 waiting-audio proof requires actual sustained media and terminal signaling", () => {
  const result = {
    final: 200,
    durationMs: 1000,
    bye: true,
    messages: [{ first: "SIP/2.0 200 OK", ms: 10 }],
    rtp: []
  };
  const events = [{ "event-name": "CHANNEL_ANSWER" }];
  assert.throws(
    () => checkEvidence(result, events, { status: 200, answered: true }),
    /sustained waiting-audio/
  );
  assert.throws(
    () => checkEvidence({ ...result, bye: false }, events, { status: 200, answered: true }),
    /BYE/
  );
});
