import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { __testing } from "./esl-events.js";

const config = {
  FREESWITCH_DOMAIN: "dialer.local"
} as AppConfig;

describe("FreeSWITCH event helpers", () => {
  it("extracts complete ESL frames and leaves partial frames buffered", () => {
    const input =
      "Content-Type: text/event-plain\nContent-Length: 4\n\nbody" +
      "Content-Type: text/event-plain\nContent-Length: 5\n\npa";

    const result = __testing.extractFrames(input);

    assert.deepEqual(result.frames, [
      {
        body: "body",
        headers: {
          "content-length": "4",
          "content-type": "text/event-plain"
        }
      }
    ]);
    assert.equal(result.rest, "Content-Type: text/event-plain\nContent-Length: 5\n\npa");
  });

  it("maps terminal events including CHANNEL_DESTROY to terminal call states", () => {
    assert.equal(__testing.mapEventToCallState("CHANNEL_HANGUP", "NORMAL_CLEARING"), "completed");
    assert.equal(__testing.mapEventToCallState("CHANNEL_HANGUP_COMPLETE", "USER_BUSY"), "completed");
    assert.equal(__testing.mapEventToCallState("CHANNEL_DESTROY"), "failed");
    assert.equal(__testing.mapEventToLegState("CHANNEL_DESTROY"), "ended");
  });

  it("maps agent and customer answer events to the correct call states", () => {
    assert.equal(__testing.mapEventToCallState("CHANNEL_ANSWER", undefined, "agent"), "agent_answered");
    assert.equal(__testing.mapEventToCallState("CHANNEL_ANSWER", undefined, "customer"), "bridged");
    assert.equal(__testing.mapEventToCallState("CHANNEL_BRIDGE"), "bridged");
  });

  it("ignores AMD human results and detects machine results", () => {
    assert.equal(
      __testing.mapVoicemailDetectionSignal({
        body: "",
        headers: {
          "amd-result": "HUMAN",
          "event-subclass": "amd::result"
        }
      }),
      null
    );

    assert.deepEqual(
      __testing.mapVoicemailDetectionSignal({
        body: "",
        headers: {
          "amd-confidence": "75",
          "amd-result": "MACHINE",
          "event-subclass": "amd::result"
        }
      }),
      {
        confidence: 75,
        eventType: "voicemail_machine_detected",
        signalType: "machine",
        status: "detected"
      }
    );
  });

  it("maps FreeSWITCH sofia registration events for the agent profile", () => {
    assert.deepEqual(
      __testing.mapAgentRegistrationEvent(config, {
        body: "",
        headers: {
          "event-name": "CUSTOM",
          "event-subclass": "sofia::register",
          "from-host": "dialer.local",
          "from-user": "agent1000",
          "profile-name": "internal-webrtc"
        }
      }),
      {
        eventSubclass: "sofia::register",
        registered: true,
        sipUsername: "agent1000"
      }
    );

    assert.deepEqual(
      __testing.mapAgentRegistrationEvent(config, {
        body: "",
        headers: {
          "event-name": "CUSTOM",
          "event-subclass": "sofia::expire",
          "from-host": "dialer.local",
          "profile-name": "internal-webrtc",
          username: "agent1000"
        }
      }),
      {
        eventSubclass: "sofia::expire",
        registered: false,
        sipUsername: "agent1000"
      }
    );
  });

  it("ignores registration events outside the agent profile or domain", () => {
    assert.equal(
      __testing.mapAgentRegistrationEvent(config, {
        body: "",
        headers: {
          "event-name": "CUSTOM",
          "event-subclass": "sofia::register",
          "from-host": "dialer.local",
          "from-user": "agent1000",
          "profile-name": "external"
        }
      }),
      null
    );

    assert.equal(
      __testing.mapAgentRegistrationEvent(config, {
        body: "",
        headers: {
          "event-name": "CUSTOM",
          "event-subclass": "sofia::register",
          "from-host": "other.local",
          "from-user": "agent1000",
          "profile-name": "internal-webrtc"
        }
      }),
      null
    );
  });

  it("persists agent registration state from sofia events", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      return rows([]);
    });

    await __testing.persistFreeSwitchEvent(config, pool, {
      body: "",
      headers: {
        "event-name": "CUSTOM",
        "event-subclass": "sofia::unregister",
        "from-host": "dialer.local",
        "from-user": "agent1000",
        "profile-name": "internal-webrtc"
      }
    });

    assert.equal(queries.length, 1);
    assert.match(queries[0]?.sql ?? "", /update agents/);
    assert.match(queries[0]?.sql ?? "", /set registered = \$2/);
    assert.match(queries[0]?.sql ?? "", /last_unregistered_at/);
    assert.match(queries[0]?.sql ?? "", /when \$2 and status = 'offline' then 'ready'/);
    assert.match(queries[0]?.sql ?? "", /when not \$2/);
    assert.match(queries[0]?.sql ?? "", /then 'offline'/);
    assert.deepEqual(queries[0]?.params, ["agent1000", false]);
  });
});

function createQueryPool(
  handler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number }
): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
