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

  it("unwraps headers and payload from text/event-plain event bodies", () => {
    const eventBody =
      "Event-Name: CUSTOM\n" +
      "Event-Subclass: avmd::beep\n" +
      "Unique-ID: 9f64cb9e-69df-4303-a68a-9f15b44ebfe7\n" +
      "variable_outbound_dialer_call_id: 1444bab4-e920-49df-b748-fa82feafce1a\n" +
      "Content-Length: 8\n\n" +
      "detected";
    const input =
      `Content-Type: text/event-plain\nContent-Length: ${Buffer.byteLength(eventBody)}\n\n` + eventBody;

    const result = __testing.extractFrames(input);

    assert.equal(result.frames.length, 1);
    assert.deepEqual(result.frames[0], {
      body: "detected",
      headers: {
        "content-length": "8",
        "content-type": "text/event-plain",
        "event-name": "CUSTOM",
        "event-subclass": "avmd::beep",
        "unique-id": "9f64cb9e-69df-4303-a68a-9f15b44ebfe7",
        variable_outbound_dialer_call_id: "1444bab4-e920-49df-b748-fa82feafce1a"
      }
    });
    assert.equal(result.rest, "");
  });

  it("maps terminal events including CHANNEL_DESTROY to terminal call states", () => {
    assert.equal(__testing.mapEventToCallState("CHANNEL_HANGUP", "NORMAL_CLEARING"), "completed");
    assert.equal(__testing.mapEventToCallState("CHANNEL_HANGUP_COMPLETE", "USER_BUSY"), "completed");
    assert.equal(__testing.mapEventToCallState("CHANNEL_DESTROY"), "failed");
    assert.equal(__testing.mapEventToCallState("CHANNEL_HANGUP", "NORMAL_CLEARING", "agent"), "agent_released");
    assert.equal(__testing.mapEventToLegState("CHANNEL_DESTROY"), "ended");
  });

  it("resolves customer hangups using answer and voicemail context", () => {
    assert.equal(
      __testing.resolveCustomerHangupOutcome({ answered: false, hangupCause: "USER_BUSY", voicemailDetected: false }),
      "busy"
    );
    assert.equal(
      __testing.resolveCustomerHangupOutcome({ answered: false, hangupCause: "NO_ANSWER", voicemailDetected: false }),
      "not_answered"
    );
    assert.equal(
      __testing.resolveCustomerHangupOutcome({ answered: true, hangupCause: "NORMAL_CLEARING", voicemailDetected: false }),
      "customer_hung_up"
    );
    assert.equal(
      __testing.resolveCustomerHangupOutcome({ answered: true, hangupCause: "NORMAL_CLEARING", voicemailDetected: true }),
      "voicemail_detected"
    );
  });

  it("does not finalize a call when the agent leg emits a terminal event", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      return rows([]);
    });

    await __testing.persistFreeSwitchEvent(config, pool, {
      body: "",
      headers: {
        "event-name": "CHANNEL_HANGUP",
        "hangup-cause": "NORMAL_CLEARING",
        "unique-id": "22222222-2222-4222-8222-222222222222",
        variable_outbound_dialer_leg_type: "agent",
        variable_outbound_dialer_call_id: "11111111-1111-4111-8111-111111111111"
      }
    });

    assert.ok(queries.some((query) => query.sql.includes("insert into call_events")));
    assert.ok(queries.some((query) => query.sql.includes("update call_legs")));
    assert.ok(!queries.some((query) => /update\s+calls/.test(query.sql)));
    assert.ok(!queries.some((query) => /update\s+agents/.test(query.sql)));
  });

  it("finalizes a customer hangup with the persisted call context", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("select answered_at, voicemail_signal_status")) {
        return rows([{ answered_at: new Date(), voicemail_signal_status: null }]);
      }
      if (sql.includes("update calls") && sql.includes("returning agent_id")) {
        return rows([{ agent_id: "agent-1" }]);
      }
      return rows([]);
    });

    await __testing.persistFreeSwitchEvent(config, pool, {
      body: "",
      headers: {
        "event-name": "CHANNEL_HANGUP",
        "hangup-cause": "NORMAL_CLEARING",
        "unique-id": "22222222-2222-4222-8222-222222222222",
        variable_outbound_dialer_leg_type: "customer",
        variable_outbound_dialer_call_id: "11111111-1111-4111-8111-111111111111"
      }
    });

    const update = queries.find((query) => query.sql.includes("update calls") && query.sql.includes("returning agent_id"));
    assert.deepEqual(update?.params, ["11111111-1111-4111-8111-111111111111", "completed", "customer_hung_up"]);
    assert.ok(queries.some((query) => /update\s+agents/.test(query.sql)));
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
