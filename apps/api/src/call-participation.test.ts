import assert from "node:assert/strict";
import { test } from "node:test";
import { participationTiming, type ParticipationTimes } from "./call-participation.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 14, 0, 0, seconds));
const waiting: ParticipationTimes = {
  arrivedAt: at(0),
  pstnAnsweredAt: at(1),
  agentConnectedAt: null,
  queueExitedAt: null,
  fallbackStartedAt: null,
  endedAt: null
};

test("B03.2 PSTN answer alone is neither queue exit nor an agent connection", () => {
  assert.deepEqual(participationTiming(waiting), { queueWaitMs: null, pstnToAgentMs: null });
  assert.deepEqual(participationTiming({ ...waiting, agentConnectedAt: at(12) }), {
    queueWaitMs: 12000,
    pstnToAgentMs: 11000
  });
  assert.deepEqual(participationTiming({ ...waiting, fallbackStartedAt: at(30) }), {
    queueWaitMs: 30000,
    pstnToAgentMs: null
  });
  assert.deepEqual(participationTiming({ ...waiting, endedAt: at(8) }), {
    queueWaitMs: 8000,
    pstnToAgentMs: null
  });
});

test("B03.2 delayed evidence uses event time; unknown or reversed clocks stay unknown", () => {
  assert.deepEqual(participationTiming({ ...waiting, queueExitedAt: at(10), agentConnectedAt: at(12) }), {
    queueWaitMs: 10000,
    pstnToAgentMs: 11000
  });
  assert.deepEqual(
    participationTiming({ ...waiting, arrivedAt: null, pstnAnsweredAt: null, endedAt: at(60) }),
    {
      queueWaitMs: null,
      pstnToAgentMs: null
    }
  );
  assert.deepEqual(participationTiming({ ...waiting, arrivedAt: at(20), agentConnectedAt: at(0) }), {
    queueWaitMs: null,
    pstnToAgentMs: null
  });
});
