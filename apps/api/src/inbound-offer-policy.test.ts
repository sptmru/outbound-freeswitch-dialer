import assert from "node:assert/strict";
import { test } from "node:test";
import { inboundOfferBlockReason, inboundOfferTimeoutMs } from "./inbound-offer-policy.js";

test("E01.1 U: dispatcher retains every admission rejection and requires current controller auth", () => {
  for (const reason of [
    "session_revoked",
    "campaign_unavailable",
    "paused",
    "not_controller",
    "revision_conflict",
    "endpoint_unavailable",
    "coordination_unavailable",
    "slot_occupied",
    "supervisor_session"
  ])
    assert.equal(inboundOfferBlockReason({ eligible: false, reason }, 1, 1), reason);
  assert.equal(inboundOfferBlockReason(null, 1, 1), "not_controller");
  for (const version of [null, undefined, 2])
    assert.equal(inboundOfferBlockReason({ eligible: true, reason: null }, version, 1), "not_controller");
  assert.equal(inboundOfferBlockReason({ eligible: true, reason: null }, 1, 1), null);
});
test("E01.1/E01.3 U: captured offer budget is bounded and has a selected default", () => {
  assert.equal(inboundOfferTimeoutMs(undefined), 15000);
  for (const value of [5000, 15000, 30000]) assert.equal(inboundOfferTimeoutMs(value), value);
  for (const value of [null, "15000", NaN, Infinity, 4999, 30001, 5000.5])
    assert.throws(() => inboundOfferTimeoutMs(value), /offer_timeout_ms/);
});
