import type { AppConfig } from "./config.js";
import { sendFreeSwitchApiCommand } from "./esl.js";

interface Logger {
  info: (value: unknown, message?: string) => void;
  warn: (value: unknown, message?: string) => void;
}

export interface EarlyMediaEventFrame {
  headers: Record<string, string>;
}

type Timer = ReturnType<typeof setTimeout>;
type SendApiCommand = typeof sendFreeSwitchApiCommand;

interface FallbackState {
  agentLegUuid: string | null;
  answerHookInstalled: boolean;
  calleeMediaDetected: boolean;
  customerLegUuid: string | null;
  fallbackActive: boolean;
  operation: Promise<void>;
  terminated: boolean;
  timer: Timer | null;
}

interface ControllerDependencies {
  clearTimer?: (timer: Timer) => void;
  sendApiCommand?: SendApiCommand;
  setTimer?: (callback: () => void, delayMilliseconds: number) => Timer;
}

export interface EarlyMediaFallbackController {
  handle: (frame: EarlyMediaEventFrame) => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
}

const MEDIA_POLL_INTERVAL_MS = 200;

export function createEarlyMediaFallbackController(
  config: AppConfig,
  logger: Logger,
  dependencies: ControllerDependencies = {}
): EarlyMediaFallbackController {
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  const sendApiCommand = dependencies.sendApiCommand ?? sendFreeSwitchApiCommand;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const states = new Map<string, FallbackState>();
  const pendingOperations = new Set<Promise<void>>();
  const tonePath = `tone_stream://${config.FREESWITCH_RINGBACK_TONE};loops=-1`;

  const track = (operation: Promise<void>) => {
    pendingOperations.add(operation);
    void operation.then(
      () => pendingOperations.delete(operation),
      () => pendingOperations.delete(operation)
    );
  };

  const enqueue = (state: FallbackState, operation: () => Promise<void>) => {
    state.operation = state.operation.then(operation, operation);
    track(state.operation);
  };

  const runApiCommand = async (command: string): Promise<string> => {
    const response = await sendApiCommand(config, command);
    if (response.body.trimStart().startsWith("-ERR")) {
      throw new Error(response.body.trim());
    }
    return response.body.trim();
  };

  const stopFallbackNow = async (callId: string, state: FallbackState, reason: string) => {
    if (!state.fallbackActive || !state.agentLegUuid) {
      return;
    }
    const agentLegUuid = state.agentLegUuid;
    state.fallbackActive = false;
    try {
      await runApiCommand(`uuid_break ${agentLegUuid} all`);
      logger.info({ agentLegUuid, callId, reason }, "stopped local early-media fallback tone");
    } catch (error) {
      if (!state.terminated) {
        logger.warn(
          { agentLegUuid, callId, message: error instanceof Error ? error.message : String(error), reason },
          "failed to stop local early-media fallback tone"
        );
      }
    }
  };

  const scheduleInspection = (callId: string, state: FallbackState, delayMilliseconds: number) => {
    if (state.timer || state.calleeMediaDetected || state.terminated) {
      return;
    }
    state.timer = setTimer(() => {
      state.timer = null;
      inspectMedia(callId, state);
    }, delayMilliseconds);
    state.timer.unref?.();
  };

  const inspectMedia = (callId: string, state: FallbackState) => {
    enqueue(state, async () => {
      if (state.terminated || state.calleeMediaDetected) {
        return;
      }
      if (!state.agentLegUuid || !state.customerLegUuid) {
        scheduleInspection(callId, state, MEDIA_POLL_INTERVAL_MS);
        return;
      }

      try {
        await runApiCommand(`uuid_set_media_stats ${state.customerLegUuid}`);
        const packetCountValue = await runApiCommand(
          `uuid_getvar ${state.customerLegUuid} rtp_audio_in_media_packet_count`
        );
        const packetCount = Number.parseInt(packetCountValue, 10);
        if (Number.isFinite(packetCount) && packetCount > 0) {
          state.calleeMediaDetected = true;
          logger.info(
            { callId, customerLegUuid: state.customerLegUuid, packetCount },
            "callee early RTP detected; local fallback remains disabled"
          );
          await stopFallbackNow(callId, state, "callee_media_detected");
          return;
        }

        if (state.terminated) {
          return;
        }

        if (!state.fallbackActive) {
          const agentLegUuid = state.agentLegUuid;
          if (!state.answerHookInstalled) {
            await runApiCommand(
              `uuid_setvar ${state.customerLegUuid} api_on_answer uuid_break ${agentLegUuid} all`
            );
            state.answerHookInstalled = true;
          }
          if (state.terminated) {
            return;
          }
          // uuid_displace only replaces existing write frames. A trunk that advertises
          // early media but sends zero RTP leaves it with no frames to replace, so use
          // playback through uuid_broadcast to create browser-bound media actively.
          await runApiCommand(`uuid_broadcast ${agentLegUuid} ${tonePath} aleg`);
          state.fallbackActive = true;
          logger.info(
            { agentLegUuid, callId, delayMilliseconds: config.FREESWITCH_EARLY_MEDIA_FALLBACK_DELAY_MS },
            "started local early-media fallback tone"
          );
        }
      } catch (error) {
        logger.warn(
          { callId, message: error instanceof Error ? error.message : String(error) },
          "failed to inspect customer early RTP; preserving callee-media priority"
        );
      }

      scheduleInspection(callId, state, MEDIA_POLL_INTERVAL_MS);
    });
  };

  const terminate = (callId: string, state: FallbackState, reason: string) => {
    state.terminated = true;
    if (state.timer) {
      clearTimer(state.timer);
      state.timer = null;
    }
    enqueue(state, () => stopFallbackNow(callId, state, reason));
    void state.operation.finally(() => {
      if (states.get(callId) === state) {
        states.delete(callId);
      }
    });
  };

  const handle = (frame: EarlyMediaEventFrame) => {
    const callId = frame.headers["variable_outbound_dialer_call_id"];
    const eventName = frame.headers["event-name"];
    const legType = frame.headers["variable_outbound_dialer_leg_type"];
    const legUuid = frame.headers["unique-id"] ?? frame.headers["variable_uuid"] ?? null;
    if (!callId || !eventName) {
      return;
    }

    let state = states.get(callId);
    const relevantStartEvent =
      (eventName === "CHANNEL_CREATE" || eventName === "CHANNEL_PROGRESS_MEDIA") &&
      (legType === "agent" || legType === "customer");
    if (!state && !relevantStartEvent) {
      return;
    }
    if (!state) {
      state = {
        agentLegUuid: null,
        answerHookInstalled: false,
        calleeMediaDetected: false,
        customerLegUuid: null,
        fallbackActive: false,
        operation: Promise.resolve(),
        terminated: false,
        timer: null
      };
      states.set(callId, state);
    }

    if (legType === "agent" && legUuid) {
      state.agentLegUuid = legUuid;
    }
    if (legType === "customer" && legUuid) {
      state.customerLegUuid = legUuid;
    }
    if (
      legType === "customer" &&
      (eventName === "CHANNEL_CREATE" || eventName === "CHANNEL_PROGRESS_MEDIA")
    ) {
      scheduleInspection(callId, state, config.FREESWITCH_EARLY_MEDIA_FALLBACK_DELAY_MS);
    }

    const customerFinished =
      legType === "customer" &&
      (eventName === "CHANNEL_ANSWER" ||
        eventName === "CHANNEL_HANGUP" ||
        eventName === "CHANNEL_HANGUP_COMPLETE" ||
        eventName === "CHANNEL_DESTROY");
    const agentFinished =
      legType === "agent" &&
      (eventName === "CHANNEL_HANGUP" ||
        eventName === "CHANNEL_HANGUP_COMPLETE" ||
        eventName === "CHANNEL_DESTROY");
    if (customerFinished || agentFinished || eventName === "CHANNEL_BRIDGE") {
      terminate(callId, state, eventName.toLowerCase());
    }
  };

  return {
    handle,
    stop: async () => {
      for (const [callId, state] of states) {
        terminate(callId, state, "listener_stopped");
      }
      while (pendingOperations.size > 0) {
        await Promise.allSettled([...pendingOperations]);
      }
    },
    waitForIdle: async () => {
      while (pendingOperations.size > 0) {
        await Promise.allSettled([...pendingOperations]);
      }
    }
  };
}
