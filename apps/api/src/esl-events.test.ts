import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { __testing, reconcileActiveCalls } from "./esl-events.js";

const config = {
  FREESWITCH_DOMAIN: "dialer.local",
  CALL_RECORDINGS_STORAGE_DIR: "/tmp"
} as AppConfig;

describe("FreeSWITCH event helpers", () => {
  it("recognizes retryable PostgreSQL and connection failures", () => {
    assert.equal(
      __testing.isTransientPersistenceError(Object.assign(new Error("connection lost"), { code: "08006" })),
      true
    );
    assert.equal(__testing.isTransientPersistenceError(new Error("database unavailable")), true);
    assert.equal(
      __testing.isTransientPersistenceError(
        Object.assign(new Error("constraint violation"), { code: "23505" })
      ),
      false
    );
  });

  it("does not let replayed channel setup events regress an active voicemail drop", async () => {
    for (const eventName of ["CHANNEL_CREATE", "CHANNEL_ANSWER", "CHANNEL_BRIDGE"]) {
      const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
      const pool = createQueryPool((sql, params) => {
        queries.push({ sql, params });
        return rows([]);
      });

      await __testing.persistFreeSwitchEvent(config, pool, {
        body: "",
        headers: {
          "event-name": eventName,
          "unique-id": "22222222-2222-4222-8222-222222222222",
          variable_outbound_dialer_call_id: "11111111-1111-4111-8111-111111111111",
          variable_outbound_dialer_leg_type: "customer"
        }
      });

      const callStateUpdate = queries.find(
        (query) => query.sql.includes("update calls") && query.sql.includes("set state =")
      );
      assert.ok(callStateUpdate, `${eventName} should attempt a guarded call-state update`);
      assert.match(callStateUpdate.sql, /'voicemail_drop_requested'/);
      assert.match(callStateUpdate.sql, /'voicemail_playback_started'/);
      assert.match(callStateUpdate.sql, /'agent_released'/);
      assert.match(callStateUpdate.sql, /'voicemail_playback_completed'/);
    }
  });

  it("builds a stable WAV path for a call recording", () => {
    assert.equal(
      __testing.buildCallRecordingPath(
        "/var/lib/freeswitch/storage/recordings/calls",
        "11111111-1111-4111-8111-111111111111"
      ),
      "/var/lib/freeswitch/storage/recordings/calls/11111111-1111-4111-8111-111111111111.wav"
    );
  });

  it("starts an enabled call recording once and persists its path", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const commands: string[] = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("update calls") && sql.includes("returning agent_id")) {
        return rows([{ agent_id: "agent-1" }]);
      }
      return rows([]);
    });

    await __testing.startCallRecording(
      {
        ...config,
        CALL_RECORDINGS_STORAGE_DIR: "/tmp"
      },
      pool,
      {
        callId: "11111111-1111-4111-8111-111111111111",
        customerLegUuid: "22222222-2222-4222-8222-222222222222"
      },
      async (_config, command) => {
        commands.push(command);
        return { body: "+OK Success\n", headers: {}, raw: "" };
      }
    );

    assert.deepEqual(commands, [
      "uuid_record 22222222-2222-4222-8222-222222222222 start /tmp/11111111-1111-4111-8111-111111111111.wav"
    ]);
    assert.ok(
      queries.some(
        (query) =>
          query.sql.includes("call_recording_path = $2") &&
          query.params[1] === "/tmp/11111111-1111-4111-8111-111111111111.wav"
      )
    );
    assert.ok(queries.some((query) => query.sql.includes("'call_recording_started'")));
    assert.ok(!queries.some((query) => query.sql.includes("call_recording_path = null")));
  });

  it("marks a recording started from early media without marking the call bridged", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("update calls") && sql.includes("returning agent_id")) {
        return rows([{ agent_id: "agent-1" }]);
      }
      return rows([]);
    });

    await __testing.startCallRecording(
      { ...config, CALL_RECORDINGS_STORAGE_DIR: "/tmp" },
      pool,
      {
        callId: "11111111-1111-4111-8111-111111111111",
        customerLegUuid: "22222222-2222-4222-8222-222222222222",
        phase: "early_media"
      },
      async () => ({ body: "+OK Success\n", headers: {}, raw: "" })
    );

    const started = queries.find((query) => query.sql.includes("'call_recording_started'"));
    assert.equal(started?.params[2], "customer_dialing");
    assert.match(String(started?.params[4]), /"phase":"early_media"/);
  });

  it("does not start AVMD in early media when the campaign setting is off", async () => {
    const commands: string[] = [];
    const pool = createQueryPool((sql) => {
      if (sql.includes("select early_media_avmd_enabled")) {
        return rows([{ early_media_avmd_enabled: false }]);
      }
      return rows([]);
    });

    await __testing.startVoicemailDetection(
      config,
      pool,
      {
        callId: "11111111-1111-4111-8111-111111111111",
        customerLegUuid: "22222222-2222-4222-8222-222222222222",
        phase: "early_media"
      },
      async (_config, command) => {
        commands.push(command);
        return { body: "true", headers: {}, raw: "" };
      }
    );

    assert.deepEqual(commands, []);
  });

  it("starts only mod_avmd in early media when the campaign setting is on", async () => {
    const commands: string[] = [];
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("select early_media_avmd_enabled")) {
        return rows([{ early_media_avmd_enabled: true }]);
      }
      return rows([]);
    });

    await __testing.startVoicemailDetection(
      config,
      pool,
      {
        callId: "11111111-1111-4111-8111-111111111111",
        customerLegUuid: "22222222-2222-4222-8222-222222222222",
        phase: "early_media"
      },
      async (_config, command) => {
        commands.push(command);
        return { body: command.startsWith("module_exists") ? "true" : "+OK Success", headers: {}, raw: "" };
      }
    );

    assert.deepEqual(commands, ["module_exists mod_avmd", "avmd 22222222-2222-4222-8222-222222222222 start"]);
    const started = queries.find(
      (query) =>
        query.sql.includes("insert into call_events") && query.sql.includes("'voicemail_detection_started'")
    );
    assert.equal(started?.params[1], "customer_dialing");
    assert.match(String(started?.params[3]), /"phase":"early_media"/);
  });

  it("does not restart early AVMD on answer and still attempts mod_amd", async () => {
    const commands: string[] = [];
    const pool = createQueryPool((sql) => {
      if (sql.includes("select raw_json")) {
        return rows([{ raw_json: { phase: "early_media", modules: { mod_avmd: { status: "started" } } } }]);
      }
      return rows([]);
    });

    await __testing.startVoicemailDetection(
      config,
      pool,
      {
        callId: "11111111-1111-4111-8111-111111111111",
        customerLegUuid: "22222222-2222-4222-8222-222222222222",
        phase: "answered"
      },
      async (_config, command) => {
        commands.push(command);
        return { body: "false", headers: {}, raw: "" };
      }
    );

    assert.deepEqual(commands, ["module_exists mod_amd"]);
  });

  it("clears the recording path and records an event when FreeSWITCH rejects recording", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("update calls") && sql.includes("returning agent_id")) {
        return rows([{ agent_id: "agent-1" }]);
      }
      return rows([]);
    });

    await __testing.startCallRecording(
      {
        ...config,
        CALL_RECORDINGS_STORAGE_DIR: "/tmp"
      },
      pool,
      {
        callId: "11111111-1111-4111-8111-111111111111",
        customerLegUuid: "22222222-2222-4222-8222-222222222222"
      },
      async () => {
        throw new Error("-ERR media bug failed");
      }
    );

    assert.ok(queries.some((query) => query.sql.includes("call_recording_path = null")));
    const failureEvent = queries.find((query) => query.sql.includes("'call_recording_failed'"));
    assert.match(String(failureEvent?.params[4]), /media bug failed/);
  });

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
    assert.equal(
      __testing.mapEventToCallState("CHANNEL_HANGUP", "NORMAL_CLEARING", "agent"),
      "agent_released"
    );
    assert.equal(__testing.mapEventToLegState("CHANNEL_DESTROY"), "ended");
  });

  it("subscribes to customer early-media events", () => {
    assert.match(__testing.eventNames, /CHANNEL_PROGRESS_MEDIA/);
    assert.equal(__testing.mapEventToCallState("CHANNEL_PROGRESS_MEDIA"), "customer_dialing");
  });

  it("resolves customer hangups using answer and voicemail context", () => {
    assert.equal(
      __testing.resolveCustomerHangupOutcome({
        answered: false,
        hangupCause: "USER_BUSY",
        voicemailDetected: false
      }),
      "busy"
    );
    assert.equal(
      __testing.resolveCustomerHangupOutcome({
        answered: false,
        hangupCause: "NO_ANSWER",
        voicemailDetected: false
      }),
      "not_answered"
    );
    assert.equal(
      __testing.resolveCustomerHangupOutcome({
        answered: true,
        hangupCause: "NORMAL_CLEARING",
        voicemailDetected: false
      }),
      "customer_hung_up"
    );
    assert.equal(
      __testing.resolveCustomerHangupOutcome({
        answered: true,
        hangupCause: "NORMAL_CLEARING",
        voicemailDetected: true
      }),
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
      if (sql.includes("select agent_id, answered_at, contact_id, state, voicemail_signal_status")) {
        return rows([
          {
            agent_id: "agent-1",
            answered_at: new Date(),
            contact_id: "contact-1",
            state: "bridged",
            voicemail_signal_status: null
          }
        ]);
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

    const update = queries.find(
      (query) => query.sql.includes("update calls") && query.sql.includes("returning agent_id")
    );
    assert.deepEqual(update?.params, [
      "11111111-1111-4111-8111-111111111111",
      "completed",
      "customer_hung_up"
    ]);
    assert.ok(queries.some((query) => /update\s+agents/.test(query.sql)));
  });

  it("keeps a normally ended voicemail drop as voicemail dropped", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("select agent_id, answered_at, contact_id, state, voicemail_signal_status")) {
        return rows([
          {
            agent_id: "agent-1",
            answered_at: new Date(),
            contact_id: "contact-1",
            state: "agent_released",
            voicemail_signal_status: "detected"
          }
        ]);
      }
      if (sql.includes("update calls") && sql.includes("outcome = 'voicemail_dropped'")) {
        return rows([
          {
            agent_id: "agent-1",
            agent_released_at: new Date(),
            contact_id: "contact-1"
          }
        ]);
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

    assert.ok(
      queries.some(
        (query) => query.sql.includes("update calls") && query.sql.includes("outcome = 'voicemail_dropped'")
      )
    );
    assert.ok(!queries.some((query) => query.params.includes("customer_hung_up")));
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

  it("maps dedicated voicemail playback custom events without treating them as AMD", () => {
    const frame = {
      body: "",
      headers: {
        "event-name": "CUSTOM",
        "event-subclass": "outbound_dialer::voicemail_playback_completed",
        "outbound-dialer-call-id": "11111111-1111-4111-8111-111111111111"
      }
    };

    assert.equal(__testing.isVoicemailPlaybackEvent(frame), true);
    assert.equal(__testing.mapVoicemailPlaybackEventKind(frame), "completed");
    assert.equal(__testing.getVoicemailPlaybackCallId(frame), "11111111-1111-4111-8111-111111111111");
  });

  it("releases only the agent leg after confirmed voicemail playback start", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const commands: string[] = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      return rows([]);
    });

    await __testing.releaseAgentAfterVoicemailPlaybackStarts(
      config,
      pool,
      {
        agentId: "agent-1",
        agentLegUuid: "22222222-2222-4222-8222-222222222222",
        callId: "11111111-1111-4111-8111-111111111111",
        customerLegUuid: "33333333-3333-4333-8333-333333333333"
      },
      async (_config, command) => {
        commands.push(command);
        return { body: "+OK", headers: {}, raw: "" };
      }
    );

    assert.deepEqual(commands, ["uuid_kill 22222222-2222-4222-8222-222222222222"]);
    assert.ok(queries.some((query) => query.sql.includes("'agent_released'")));
    assert.ok(queries.some((query) => query.sql.includes("agent_released_at")));
    const legUpdate = queries.find((query) => query.sql.includes("update call_legs"));
    assert.match(legUpdate?.sql ?? "", /type = 'agent'/);
    assert.ok(!queries.some((query) => query.sql.includes("type = 'customer'")));
    const callUpdate = queries.find((query) => query.sql.includes("update calls"));
    assert.doesNotMatch(callUpdate?.sql ?? "", /ended_at\s*=/);
    const availabilityUpdate = queries.find((query) => query.sql.includes("availability_status = case"));
    assert.deepEqual(availabilityUpdate?.params, ["agent-1"]);
  });

  it("finalizes a voicemail drop only after the completion event", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("update calls")) {
        return rows([{ agent_id: "agent-1", contact_id: "contact-1" }]);
      }
      return rows([]);
    });

    await __testing.finalizeCompletedVoicemailPlayback(
      config,
      pool,
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
      { playbackMilliseconds: 4200 }
    );

    const callUpdate = queries.find((query) => query.sql.includes("update calls"));
    assert.match(callUpdate?.sql ?? "", /outcome = 'voicemail_dropped'/);
    assert.match(callUpdate?.sql ?? "", /voicemail_playback_completed_at/);
    assert.match(callUpdate?.sql ?? "", /ended_at = coalesce/);
    assert.ok(queries.some((query) => query.sql.includes("'voicemail_playback_completed'")));
    assert.ok(
      queries.some((query) => query.sql.includes("update contacts") && query.sql.includes("'completed'"))
    );
    assert.ok(queries.some((query) => query.sql.includes("update call_legs")));
    assert.ok(
      queries.some((query) => query.sql.includes("update agents") && query.sql.includes("not exists"))
    );
  });

  it("does not clear newer pause or wrap-up state when a released voicemail job finishes", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("update calls")) {
        return rows([
          {
            agent_id: "agent-1",
            agent_released_at: new Date("2026-07-13T08:00:00.000Z"),
            contact_id: "contact-1"
          }
        ]);
      }
      return rows([]);
    });

    await __testing.finalizeCompletedVoicemailPlayback(
      config,
      pool,
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
      {}
    );

    assert.ok(!queries.some((query) => query.sql.includes("update agents")));
  });

  it("requeues an interrupted voicemail playback instead of reporting a completed drop", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("update calls")) {
        return rows([{}]);
      }
      return rows([]);
    });

    await __testing.finalizeIncompleteVoicemailPlayback(config, pool, {
      agentId: "agent-1",
      agentReleased: false,
      callId: "11111111-1111-4111-8111-111111111111",
      contactId: "contact-1",
      customerLegUuid: "33333333-3333-4333-8333-333333333333",
      hangupCause: "NORMAL_CLEARING",
      raw: {},
      source: "test"
    });

    const update = queries.find((query) => query.sql.includes("update calls"));
    assert.deepEqual(update?.params, [
      "11111111-1111-4111-8111-111111111111",
      "completed",
      "customer_hung_up"
    ]);
    assert.ok(queries.some((query) => query.params.includes("voicemail_playback_interrupted")));
    assert.ok(
      queries.some((query) => query.sql.includes("update contacts") && query.sql.includes("status = 'new'"))
    );
  });

  it("does not clear newer agent availability when released voicemail playback is interrupted", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createTransactionalQueryPool((sql, params) => {
      queries.push({ sql, params });
      return sql.includes("update calls") ? rows([{}]) : rows([]);
    });

    await __testing.finalizeIncompleteVoicemailPlayback(config, pool, {
      agentId: "agent-1",
      agentReleased: true,
      callId: "11111111-1111-4111-8111-111111111111",
      contactId: "contact-1",
      customerLegUuid: "33333333-3333-4333-8333-333333333333",
      forceFailed: true,
      raw: {},
      source: "test"
    });

    assert.ok(!queries.some((query) => query.sql.includes("update agents")));
  });

  it("uses a conservative outcome policy for contact retry eligibility", () => {
    assert.equal(__testing.contactStatusForOutcome("customer_hung_up"), "completed");
    assert.equal(__testing.contactStatusForOutcome("voicemail_detected"), "completed");
    assert.equal(__testing.contactStatusForOutcome("voicemail_dropped"), "completed");
    assert.equal(__testing.contactStatusForOutcome("busy"), "new");
    assert.equal(__testing.contactStatusForOutcome("not_answered"), "new");
    assert.equal(__testing.contactStatusForOutcome("failed"), "new");
  });

  it("reconciles an old missing answered call without requeueing its contact", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("calls.id as call_id")) {
        return rows([
          {
            agent_id: "agent-1",
            agent_leg_uuid: null,
            answered_at: new Date("2026-07-13T08:00:00.000Z"),
            call_id: "11111111-1111-4111-8111-111111111111",
            contact_id: "contact-1",
            created_at: new Date("2000-01-01T00:00:00.000Z"),
            customer_leg_uuid: "33333333-3333-4333-8333-333333333333",
            state: "bridged"
          }
        ]);
      }
      if (sql.includes("update calls")) {
        return rows([{ agent_id: "agent-1", contact_id: "contact-1" }]);
      }
      return rows([]);
    });
    const logger = {
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined
    };

    await reconcileActiveCalls(config, pool, logger, async () => ({ body: "false", headers: {}, raw: "" }));

    const callUpdate = queries.find((query) => query.sql.includes("update calls"));
    assert.deepEqual(callUpdate?.params, [
      "11111111-1111-4111-8111-111111111111",
      "completed",
      "customer_hung_up"
    ]);
    const contactUpdate = queries.find((query) => query.sql.includes("update contacts"));
    assert.deepEqual(contactUpdate?.params, ["contact-1", "completed"]);
    assert.ok(queries.some((query) => query.sql.includes("freeswitch_reconciliation_closed_missing_call")));
  });

  it("fails and terminates a voicemail drop whose playback start event never arrives", async () => {
    const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
    const commands: string[] = [];
    const pool = createTransactionalQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("calls.id as call_id")) {
        return rows([
          {
            agent_id: "agent-1",
            agent_leg_uuid: "22222222-2222-4222-8222-222222222222",
            answered_at: new Date("2026-07-13T08:00:00.000Z"),
            call_id: "11111111-1111-4111-8111-111111111111",
            contact_id: "contact-1",
            created_at: new Date("2026-07-13T08:00:00.000Z"),
            customer_leg_uuid: "33333333-3333-4333-8333-333333333333",
            state: "voicemail_drop_requested",
            voicemail_drop_requested_at: new Date("2000-01-01T00:00:00.000Z")
          }
        ]);
      }
      if (sql.includes("update calls") && sql.includes("set state = $2")) {
        return rows([{}]);
      }
      return rows([]);
    });
    const logger = { error: () => undefined, info: () => undefined, warn: () => undefined };

    await reconcileActiveCalls(
      { ...config, VOICEMAIL_DROP_START_TIMEOUT_SECONDS: 120 } as AppConfig,
      pool,
      logger,
      async (_config, command) => {
        commands.push(command);
        return { body: command.startsWith("uuid_exists") ? "true" : "+OK", headers: {}, raw: "" };
      }
    );

    assert.deepEqual(commands, [
      "uuid_exists 33333333-3333-4333-8333-333333333333",
      "uuid_kill 33333333-3333-4333-8333-333333333333",
      "uuid_kill 22222222-2222-4222-8222-222222222222"
    ]);
    assert.ok(
      queries.some(
        (query) =>
          query.sql.includes("update calls") && query.params[1] === "failed" && query.params[2] === "failed"
      )
    );
    assert.ok(
      queries.some((query) => String(query.params.at(-1)).includes("reconciliation_voicemail_start_timeout"))
    );
  });
});

function createQueryPool(
  handler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number }
): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

function createTransactionalQueryPool(
  handler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number }
): pg.Pool {
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params)),
    release: () => undefined
  } as unknown as pg.PoolClient;
  return {
    connect: () => Promise.resolve(client),
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
