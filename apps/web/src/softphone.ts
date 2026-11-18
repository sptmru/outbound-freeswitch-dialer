import { DeskSessionController, type DeskControl } from "./desk-session";
import { watchRecoveredDialog } from "./sip-dialog-recovery";
import { serviceInviteIdentity, serviceInviteMatches } from "./service-invites";
import type { DeskSessionSnapshot } from "./types";
import { useEffect, useRef, useState } from "react";
import { Invitation, Registerer, RegistererState, SessionState, UserAgent } from "sip.js";
import { authorizeServiceInvite, fetchSoftphoneProvisioning, submitBrowserMediaTelemetry } from "./api";
import {
  buildMicrophoneConstraints,
  classifyAudioSignal,
  classifyNetworkReadiness,
  readAppliedMicrophoneSettings
} from "./audio-setup";
import type {
  AppliedMicrophoneSettings,
  AudioCheckResult,
  AudioDeviceOption,
  AudioSignalStatus,
  MicrophoneProcessingProfile
} from "./audio-setup";
import { BrowserMediaTelemetryCollector } from "./browser-media";
import { createBrowserRingbackController, type BrowserRingbackController } from "./browser-ringback";
import type { PublicUser } from "./types";

export type SoftphoneRuntimeState =
  "idle" | "requesting_microphone" | "registering" | "registered" | "failed";

interface SoftphoneCoreRuntime {
  registered: boolean;
  microphoneAllowed: boolean;
  state: SoftphoneRuntimeState;
  callState: "none" | "incoming" | "answering" | "active";
  audioPlaybackState: "idle" | "starting" | "playing" | "blocked" | "unavailable";
  label: string;
  detail: string;
  error: string | null;
  incomingCallLabel: string | null;
  answerIncomingCall: () => Promise<void>;
  declineIncomingCall: () => Promise<void>;
  hangUpSoftphoneCall: () => Promise<void>;
  retryRemoteAudio: () => Promise<void>;
  startBrowserRingback: () => void;
  stopBrowserRingback: () => void;
}

export interface AudioSetupRuntime {
  appliedSettings: AppliedMicrophoneSettings | null;
  checkError: string | null;
  checkResult: AudioCheckResult | null;
  checking: boolean;
  inputDevices: AudioDeviceOption[];
  inputLevel: number;
  outputDevices: AudioDeviceOption[];
  outputSelectionSupported: boolean;
  processingProfile: MicrophoneProcessingProfile;
  selectedInputId: string;
  selectedOutputId: string;
  signalStatus: AudioSignalStatus;
}

export interface SoftphoneRuntime extends SoftphoneCoreRuntime {
  deskSession?: DeskSessionSnapshot | null;
  audioSetup: AudioSetupRuntime;
  refreshAudioDevices: () => Promise<void>;
  runAudioCheck: () => Promise<void>;
  selectMicrophone: (deviceId: string) => void;
  selectSpeaker: (deviceId: string) => Promise<void>;
  setMicrophoneProcessingProfile: (profile: MicrophoneProcessingProfile) => void;
}

const idleRuntime: SoftphoneCoreRuntime = {
  registered: false,
  microphoneAllowed: false,
  state: "idle",
  callState: "none",
  audioPlaybackState: "idle",
  label: "Softphone idle",
  detail: "Sign in to register this browser",
  error: null,
  incomingCallLabel: null,
  answerIncomingCall: async () => undefined,
  declineIncomingCall: async () => undefined,
  hangUpSoftphoneCall: async () => undefined,
  retryRemoteAudio: async () => undefined,
  startBrowserRingback: () => undefined,
  stopBrowserRingback: () => undefined
};

const initialAudioSetup: AudioSetupRuntime = {
  appliedSettings: null,
  checkError: null,
  checkResult: null,
  checking: false,
  inputDevices: [],
  inputLevel: 0,
  outputDevices: [],
  outputSelectionSupported:
    typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype,
  processingProfile: "office",
  selectedInputId: "",
  selectedOutputId: "",
  signalStatus: "idle"
};

const audioInputStorageKey = "outbound_dialer_audio_input_id";
const audioOutputStorageKey = "outbound_dialer_audio_output_id";
const audioProfileStorageKey = "outbound_dialer_audio_processing_profile";
const audioCheckDurationMs = 3_000;
const iceGatheringTimeoutMs = 4_000;

const registrationTimeoutMs = 20_000;
const mediaTelemetrySampleIntervalMs = 5_000;
const mediaTelemetryUploadEverySamples = 6;
const sipDiagnosticsEnabled = import.meta.env.DEV || import.meta.env.VITE_SIP_DIAGNOSTICS === "true";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ActiveBrowserMediaTelemetry = {
  callId: string;
  legUuid?: string;
  collector: BrowserMediaTelemetryCollector;
  intervalId: number;
  sampling: boolean;
};

function toRegistrationFailureRuntime(
  current: SoftphoneCoreRuntime,
  detail: string,
  error: string
): SoftphoneCoreRuntime {
  return {
    ...current,
    registered: false,
    state: "failed",
    callState: "none",
    audioPlaybackState: "idle",
    label: "Softphone offline",
    detail,
    error,
    incomingCallLabel: null
  };
}

function toCallIdleRuntime(current: SoftphoneCoreRuntime, registeredDetail: string): SoftphoneCoreRuntime {
  return {
    ...current,
    callState: "none",
    audioPlaybackState: "idle",
    label: current.registered ? "Softphone registered" : current.label,
    detail: current.registered ? registeredDetail : current.detail,
    incomingCallLabel: null
  };
}

function formatRegisterRejectError(statusCode?: number, reasonPhrase?: string): string {
  return `REGISTER rejected${statusCode ? ` ${statusCode}` : ""}${reasonPhrase ? ` ${reasonPhrase}` : ""}`;
}

async function stopSoftphoneRegistration(
  registerer: { unregister: () => Promise<unknown> } | null,
  userAgent: { stop: () => Promise<unknown> } | null
): Promise<void> {
  try {
    await registerer?.unregister();
  } catch {
    // Closing the transport still guarantees local cleanup if unregister fails.
  }
  await userAgent?.stop().catch(() => undefined);
}

async function stopInvitation(invitation: Invitation): Promise<void> {
  if (invitation.state === SessionState.Established) {
    await invitation.bye().catch(() => undefined);
    return;
  }
  await invitation.reject().catch(async () => {
    await invitation.bye().catch(() => undefined);
  });
}

export function useSoftphoneRegistration(
  user: PublicUser | null,
  deskControl?: DeskControl
): SoftphoneRuntime {
  const [deskSession, setDeskSession] = useState<DeskSessionSnapshot | null>(null);
  const deskSessionRef = useRef<DeskSessionSnapshot | null>(null);
  const deskControllerRef = useRef<DeskSessionController | null>(null);
  const deskControlRef = useRef(deskControl);
  deskControlRef.current = deskControl;
  useEffect(() => {
    deskControllerRef.current?.selectCampaign(deskControl?.campaignId ?? null);
  }, [deskControl?.campaignId]);
  const invitationRef = useRef<Invitation | null>(null);
  const authorizedInvitationsRef = useRef(new WeakSet<Invitation>());
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const browserMediaTelemetryRef = useRef<ActiveBrowserMediaTelemetry | null>(null);
  const browserRingbackRef = useRef<BrowserRingbackController | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const registrationGenerationRef = useRef(0);
  const [runtime, setRuntime] = useState<SoftphoneCoreRuntime>(idleRuntime);
  const [audioSetup, setAudioSetup] = useState<AudioSetupRuntime>(() => loadAudioSetup());
  const selectedOutputRef = useRef(audioSetup.selectedOutputId);
  selectedOutputRef.current = audioSetup.selectedOutputId;
  const microphoneConstraints = buildMicrophoneConstraints(
    audioSetup.processingProfile,
    audioSetup.selectedInputId
  );

  function selectMicrophone(deviceId: string) {
    if (runtime.callState !== "none") return;
    persistPreference(audioInputStorageKey, deviceId);
    setAudioSetup((current) => ({
      ...current,
      appliedSettings: null,
      checkError: null,
      checkResult: null,
      selectedInputId: deviceId,
      signalStatus: "idle"
    }));
  }

  async function selectSpeaker(deviceId: string) {
    persistPreference(audioOutputStorageKey, deviceId);
    setAudioSetup((current) => ({ ...current, checkError: null, selectedOutputId: deviceId }));
    const audio = remoteAudioRef.current;
    if (audio) {
      try {
        await applyAudioOutput(audio, deviceId);
      } catch (error) {
        setAudioSetup((current) => ({
          ...current,
          checkError: error instanceof Error ? error.message : "Could not select this speaker"
        }));
      }
    }
  }

  function setMicrophoneProcessingProfile(profile: MicrophoneProcessingProfile) {
    if (runtime.callState !== "none") return;
    persistPreference(audioProfileStorageKey, profile);
    setAudioSetup((current) => ({
      ...current,
      appliedSettings: null,
      checkError: null,
      checkResult: null,
      processingProfile: profile,
      signalStatus: "idle"
    }));
  }

  async function refreshAudioDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setAudioSetup((current) => reconcileAudioDevices(current, devices));
  }

  async function runAudioCheck() {
    if (!navigator.mediaDevices?.getUserMedia || audioSetup.checking || runtime.callState !== "none") {
      return;
    }
    setAudioSetup((current) => ({
      ...current,
      checkError: null,
      checkResult: null,
      checking: true,
      inputLevel: 0,
      signalStatus: "listening"
    }));

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints, video: false });
      const track = firstAudioTrack(stream);
      if (!track) throw new Error("The selected microphone did not provide an audio track");
      const appliedSettings = readAppliedMicrophoneSettings(track);
      setAudioSetup((current) => ({ ...current, appliedSettings }));
      await refreshAudioDevices();
      const [signal, candidateTypes] = await Promise.all([
        measureMicrophoneSignal(stream, (inputLevel) => {
          setAudioSetup((current) => ({ ...current, inputLevel }));
        }),
        gatherIceCandidateTypes(iceServersRef.current)
      ]);
      const result: AudioCheckResult = {
        appliedSettings,
        ...classifyAudioSignal(signal),
        ...classifyNetworkReadiness({ candidateTypes, registered: runtime.registered })
      };
      setAudioSetup((current) => ({
        ...current,
        checkResult: result,
        checking: false,
        inputLevel: result.inputPeakPercent / 100,
        signalStatus: result.signalStatus
      }));
    } catch (error) {
      setAudioSetup((current) => ({
        ...current,
        checkError: error instanceof Error ? error.message : "Audio check failed",
        checking: false,
        inputLevel: 0,
        signalStatus: "idle"
      }));
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  async function answerIncomingCall() {
    // Native service media is answered only by the durable authorization path.
    if (deskControlRef.current) return;
    const invitation = invitationRef.current;
    if (!invitation) {
      return;
    }
    const generation = registrationGenerationRef.current;
    await acceptInvitation(
      invitation,
      runtime.incomingCallLabel ?? "Connecting",
      () => registrationGenerationRef.current === generation
    );
  }

  function startBrowserRingback() {
    if (!browserRingbackRef.current) {
      browserRingbackRef.current = createBrowserRingbackController();
    }
    browserRingbackRef.current.start(selectedOutputRef.current);
  }

  function stopBrowserRingback() {
    browserRingbackRef.current?.stop();
  }

  async function acceptInvitation(
    invitation: Invitation,
    incomingCallLabel: string,
    isCurrent: () => boolean
  ) {
    setRuntime((current) => ({
      ...current,
      callState: "answering",
      label: "Connecting softphone",
      detail: incomingCallLabel,
      error: null
    }));
    await invitation.accept({
      sessionDescriptionHandlerOptions: {
        constraints: {
          audio: microphoneConstraints,
          video: false
        }
      }
    });
    if (!isCurrent()) {
      await stopInvitation(invitation);
    }
  }

  async function declineIncomingCall() {
    const invitation = invitationRef.current;
    if (!invitation) {
      return;
    }
    await invitation.reject();
    invitationRef.current = null;
    clearRemoteAudio();
    setRuntime((current) => toCallIdleRuntime(current, "Ready for calls"));
  }

  async function hangUpSoftphoneCall() {
    stopBrowserRingback();
    const invitation = invitationRef.current;
    if (!invitation) {
      return;
    }
    await stopInvitation(invitation);
    invitationRef.current = null;
    clearRemoteAudio();
    setRuntime((current) => toCallIdleRuntime(current, "Ready for calls"));
  }

  useEffect(() => {
    if (!user || !navigator.mediaDevices?.enumerateDevices) return;
    const updateDevices = () => void refreshAudioDevices().catch(() => undefined);
    updateDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", updateDevices);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", updateDevices);
  }, [user?.id]);

  useEffect(() => {
    const generation = ++registrationGenerationRef.current;
    if (!user) {
      invitationRef.current = null;
      setRuntime(idleRuntime);
      return;
    }

    const deskController = deskControlRef.current
      ? new DeskSessionController(deskControlRef.current, (session) => {
          deskSessionRef.current = session;
          setDeskSession(session);
        })
      : null;
    deskControllerRef.current = deskController;
    const deskHeartbeat = deskController
      ? window.setInterval(() => void deskController.heartbeat().catch(() => {}), 5000)
      : null;
    let cancelled = false;
    let mediaStream: MediaStream | null = null;
    let microphoneAllowed = false;
    let registerer: Registerer | null = null;
    let registrationTimer: number | null = null;
    let userAgent: UserAgent | null = null;
    let registrationCleanupStarted = false;
    let reconnectTimer: number | null = null;
    let recoveringTransport = false;
    let reconnectAttempts = 0;
    let registrationDetail = "";
    let dialogRecovery: ReturnType<typeof watchRecoveredDialog> | null = null;
    let recoveryInvitation: Invitation | null = null;
    const consumedOperations = new Set<string>();
    const pendingAuthorizations = new Set<AbortController>();
    const isCurrent = () => !cancelled && registrationGenerationRef.current === generation;
    const clearRegistrationTimer = () => {
      if (registrationTimer) {
        window.clearTimeout(registrationTimer);
        registrationTimer = null;
      }
    };
    const stopCurrentRegistration = async () => {
      if (registrationCleanupStarted) return;
      registrationCleanupStarted = true;
      dialogRecovery?.stop();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      clearRegistrationTimer();
      const currentRegisterer = registerer;
      const currentUserAgent = userAgent;
      registerer = null;
      userAgent = null;
      await stopSoftphoneRegistration(currentRegisterer, currentUserAgent);
    };
    const getActions = () => ({
      answerIncomingCall,
      declineIncomingCall,
      hangUpSoftphoneCall,
      retryRemoteAudio,
      startBrowserRingback,
      stopBrowserRingback
    });
    const failRegistration = (
      detail: string,
      error: string,
      options: { preserveExistingError?: boolean } = {}
    ) => {
      if (!isCurrent()) {
        return;
      }
      clearRegistrationTimer();
      deskController?.setRegistered(false);
      void deskController?.heartbeat().catch(() => {});
      // Registration is signaling evidence, not authority to terminate media.
      if (invitationRef.current) {
        setRuntime((current) => ({ ...current, registered: false, state: "failed", detail, error }));
        return;
      }
      invitationRef.current = null;
      clearRemoteAudio();
      void stopCurrentRegistration();
      setRuntime((current) => {
        if (options.preserveExistingError && current.state === "failed" && current.error) {
          return current;
        }
        return toRegistrationFailureRuntime(current, detail, error);
      });
    };
    const confirmRegistration = () => {
      if (!isCurrent() || registrationCleanupStarted) return;
      recoveringTransport = false;
      reconnectAttempts = 0;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearRegistrationTimer();
      deskController?.setRegistered(true);
      void deskController?.heartbeat().catch(() => {});
      dialogRecovery?.connected();
      setRuntime((current) => ({
        ...current,
        registered: true,
        microphoneAllowed: true,
        state: "registered",
        label: "Softphone registered",
        detail: registrationDetail,
        error: null
      }));
    };
    const recoverTransport = (error: unknown) => {
      if (!isCurrent() || registrationCleanupStarted) return;
      const invitation = invitationRef.current;
      if (invitation && recoveryInvitation !== invitation) {
        dialogRecovery?.stop();
        recoveryInvitation = invitation;
        dialogRecovery = watchRecoveredDialog(
          invitation,
          () => isCurrent() && invitationRef.current === invitation,
          () => {
            void stopInvitation(invitation);
          }
        );
      }
      dialogRecovery?.disconnected();
      clearRegistrationTimer();
      deskController?.setRegistered(false);
      void deskController?.heartbeat().catch(() => {});
      setRuntime((current) => ({
        ...current,
        registered: false,
        state: "registering",
        detail: "Reconnecting call signaling",
        error: error instanceof Error ? error.message : "SIP transport disconnected"
      }));
      if (recoveringTransport) return;
      recoveringTransport = true;
      reconnectAttempts = 0;
      const retry = () => {
        if (!isCurrent() || registrationCleanupStarted || !recoveringTransport) return;
        if (++reconnectAttempts > 5) {
          recoveringTransport = false;
          setRuntime((current) => ({
            ...current,
            registered: false,
            state: "failed",
            detail: "Call signaling could not reconnect",
            error: "Reconnect attempts exhausted"
          }));
          return;
        }
        reconnectTimer = window.setTimeout(async () => {
          reconnectTimer = null;
          if (!isCurrent() || registrationCleanupStarted || !recoveringTransport) return;
          try {
            await userAgent?.reconnect();
            if (!isCurrent() || registrationCleanupStarted || !recoveringTransport) return;
            // SIP.js may remain Registered across transport loss and therefore
            // omit a stateChange on refresh. The accepted response also confirms it.
            await registerer?.register({ requestDelegate: { onAccept: confirmRegistration } });
          } catch {
            // Transport errors can also invoke onDisconnect; this loop owns retries.
          }
          if (isCurrent() && recoveringTransport) retry();
        }, 2000);
      };
      retry();
    };

    async function register() {
      try {
        setRuntime({
          registered: false,
          microphoneAllowed: false,
          state: "requesting_microphone",
          callState: "none",
          audioPlaybackState: "idle",
          label: "Mic permission",
          detail: "Waiting for browser access",
          error: null,
          incomingCallLabel: null,
          ...getActions()
        });

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Browser microphone access is unavailable");
        }

        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: microphoneConstraints,
          video: false
        });
        const microphoneTrack = firstAudioTrack(mediaStream);
        if (microphoneTrack) {
          const appliedSettings = readAppliedMicrophoneSettings(microphoneTrack);
          setAudioSetup((current) => ({ ...current, appliedSettings }));
        }
        await refreshAudioDevices();
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
        if (!isCurrent()) {
          return;
        }
        microphoneAllowed = true;

        setRuntime({
          registered: false,
          microphoneAllowed: true,
          state: "registering",
          callState: "none",
          audioPlaybackState: "idle",
          label: "Registering",
          detail: "Connecting this browser to the calling server",
          error: null,
          incomingCallLabel: null,
          ...getActions()
        });

        const provisioning = deskController
          ? await deskController.start()
          : await fetchSoftphoneProvisioning();
        if (!isCurrent()) {
          return;
        }
        iceServersRef.current = provisioning.iceServers;
        registrationDetail = `${provisioning.sipUsername}@${provisioning.domain}`;
        const uri = UserAgent.makeURI(provisioning.sipUri);
        if (!uri) {
          throw new Error("Invalid SIP provisioning URI");
        }

        userAgent = new UserAgent({
          ...(deskController ? { contactName: provisioning.sipUsername } : {}),
          authorizationPassword: provisioning.sipPassword,
          authorizationUsername: provisioning.sipUsername,
          displayName: provisioning.displayName,
          logBuiltinEnabled: sipDiagnosticsEnabled,
          logLevel: sipDiagnosticsEnabled ? "debug" : "warn",
          delegate: {
            onInvite: async (invitation) => {
              if (!isCurrent()) {
                void invitation.reject().catch(() => undefined);
                return;
              }
              if (invitationRef.current) {
                if (invitationRef.current !== invitation) void invitation.reject().catch(() => undefined);
                return;
              }
              if (
                !deskController &&
                [
                  "X-Outbound-Dialer-Operation-ID",
                  "X-Outbound-Dialer-Desk-Session-ID",
                  "X-Outbound-Dialer-Binding-Generation"
                ].some((h) => invitation.request.getHeader(h))
              ) {
                void invitation.reject().catch(() => undefined);
                return;
              }

              const incomingCallLabel = invitation.remoteIdentity.displayName || "Outbound Dialer Test";
              invitationRef.current = invitation;
              invitation.delegate = {
                ...invitation.delegate,
                onRefer: (referral) => {
                  void referral.reject().catch(() => undefined);
                }
              };
              const ownsInvitation = () => isCurrent() && invitationRef.current === invitation;
              invitation.stateChange.addListener((state) => {
                if (!ownsInvitation()) {
                  return;
                }
                if (state === SessionState.Established) {
                  if (deskController && !authorizedInvitationsRef.current.has(invitation)) {
                    void stopInvitation(invitation);
                    return;
                  }
                  setRuntime((current) => ({
                    ...current,
                    callState: "active",
                    label: "Softphone call active",
                    detail: incomingCallLabel,
                    error: null,
                    incomingCallLabel
                  }));
                  void attachRemoteAudio(invitation, ownsInvitation);
                  startBrowserMediaTelemetry(invitation);
                }
                if (state === SessionState.Terminated) {
                  if (recoveryInvitation === invitation) {
                    dialogRecovery?.stop();
                    dialogRecovery = null;
                    recoveryInvitation = null;
                  }
                  finalizeBrowserMediaTelemetry();
                  invitationRef.current = null;
                  clearRemoteAudio();
                  setRuntime((current) =>
                    toCallIdleRuntime(current, `${provisioning.sipUsername}@${provisioning.domain}`)
                  );
                }
              });

              const accept = async () => {
                if (deskController) {
                  const input = serviceInviteIdentity(invitation.request, deskSessionRef.current);
                  if (!input || consumedOperations.has(input.operationId))
                    throw new Error("Service invitation is unavailable");
                  const abort = new AbortController();
                  pendingAuthorizations.add(abort);
                  const timer = window.setTimeout(() => abort.abort(), 2500);
                  try {
                    const result = await authorizeServiceInvite(input, abort.signal);
                    // HTTP response and acceptance click timing are not media authority.
                    // Recheck lifecycle/binding after the asynchronous SQL authorization.
                    if (
                      abort.signal.aborted ||
                      !ownsInvitation() ||
                      invitation.state === SessionState.Terminated ||
                      !serviceInviteIdentity(invitation.request, deskSessionRef.current) ||
                      !serviceInviteMatches(input, result)
                    ) {
                      throw new Error("Service invitation is no longer current");
                    }
                    consumedOperations.add(input.operationId);
                    authorizedInvitationsRef.current.add(invitation);
                  } finally {
                    window.clearTimeout(timer);
                    pendingAuthorizations.delete(abort);
                  }
                }
                if (ownsInvitation()) await acceptInvitation(invitation, incomingCallLabel, ownsInvitation);
              };
              void accept().catch((error: unknown) => {
                if (!ownsInvitation()) {
                  void invitation.reject().catch(() => undefined);
                  return;
                }
                invitationRef.current = null;
                void stopInvitation(invitation);
                clearRemoteAudio();
                setRuntime((current) => ({
                  ...toCallIdleRuntime(current, `${provisioning.sipUsername}@${provisioning.domain}`),
                  error: error instanceof Error ? error.message : "Softphone call failed"
                }));
              });
            },
            onDisconnect: (error) => {
              if (!isCurrent()) {
                return;
              }
              if (deskController || invitationRef.current) {
                recoverTransport(error);
                return;
              }
              failRegistration(
                "SIP transport disconnected",
                error instanceof Error ? error.message : "WebSocket connection to FreeSWITCH closed",
                { preserveExistingError: true }
              );
            }
          },
          transportOptions: {
            server: provisioning.websocketUrl,
            traceSip: sipDiagnosticsEnabled
          },
          uri,
          sessionDescriptionHandlerFactoryOptions: {
            peerConnectionConfiguration: {
              iceServers: provisioning.iceServers
            },
            constraints: {
              audio: microphoneConstraints,
              video: false
            }
          }
        });
        registerer = new Registerer(userAgent);
        registerer.stateChange.addListener((state) => {
          if (!isCurrent()) {
            return;
          }

          deskController?.setRegistered(state === RegistererState.Registered);
          if (state === RegistererState.Registered) {
            confirmRegistration();
            return;
          }

          if (state === RegistererState.Unregistered || state === RegistererState.Terminated) {
            if (recoveringTransport) return;
            if (state === RegistererState.Terminated) {
              failRegistration(
                "SIP registration terminated",
                "SIP.js registerer terminated before this browser was registered",
                {
                  preserveExistingError: true
                }
              );
              return;
            }
            failRegistration(
              "SIP registration did not complete",
              "FreeSWITCH did not keep this browser registered. Check SIP.js logs.",
              { preserveExistingError: true }
            );
          }
        });
        await userAgent.start();
        if (!isCurrent()) {
          await stopSoftphoneRegistration(registerer, userAgent);
          return;
        }
        registrationTimer = window.setTimeout(() => {
          if (!isCurrent()) {
            return;
          }
          failRegistration(
            "SIP registration timed out",
            `No accepted REGISTER response within ${registrationTimeoutMs / 1000}s. Check browser console for SIP.js logs.`
          );
        }, registrationTimeoutMs);
        await registerer.register({
          requestDelegate: {
            onAccept: () => {
              if (!isCurrent()) {
                return;
              }
              setRuntime((current) => ({
                ...current,
                registered: current.state === "registered" ? current.registered : false,
                state: current.state === "registered" ? current.state : "registering",
                label: current.state === "registered" ? current.label : "Registration accepted",
                detail:
                  current.state === "registered"
                    ? current.detail
                    : "Waiting for softphone registration confirmation",
                error: null
              }));
            },
            onReject: (response) => {
              if (!isCurrent()) {
                return;
              }
              failRegistration(
                "SIP registration rejected",
                formatRegisterRejectError(response.message.statusCode, response.message.reasonPhrase)
              );
            }
          }
        });

        if (!isCurrent()) {
          await stopSoftphoneRegistration(registerer, userAgent);
          return;
        }
        if (registrationCleanupStarted) {
          return;
        }

        setRuntime((current) => ({
          ...current,
          registered: current.state === "registered" && current.registered,
          microphoneAllowed: true,
          state: current.state === "registered" ? current.state : "registering",
          label: current.state === "registered" ? current.label : "Registration sent",
          detail: current.state === "registered" ? current.detail : "Waiting for accepted SIP registration",
          error: current.state === "registered" ? null : current.error,
          ...getActions()
        }));
      } catch (error) {
        if (!isCurrent()) {
          mediaStream?.getTracks().forEach((track) => track.stop());
          await stopSoftphoneRegistration(registerer, userAgent);
          return;
        }
        if (invitationRef.current) {
          failRegistration(
            "SIP registration failed",
            error instanceof Error ? error.message : "Registration failed"
          );
          return;
        }
        clearRegistrationTimer();
        await stopCurrentRegistration();
        setRuntime({
          registered: false,
          microphoneAllowed,
          state: "failed",
          callState: "none",
          audioPlaybackState: "idle",
          label: "Softphone offline",
          detail: "Registration failed",
          error: error instanceof Error ? error.message : "Softphone registration failed",
          incomingCallLabel: null,
          ...getActions()
        });
      }
    }

    void register();

    return () => {
      cancelled = true;
      for (const abort of pendingAuthorizations) abort.abort();
      if (deskHeartbeat !== null) window.clearInterval(deskHeartbeat);
      void deskController?.close();
      if (deskControllerRef.current === deskController) deskControllerRef.current = null;
      if (registrationGenerationRef.current === generation) {
        registrationGenerationRef.current += 1;
      }
      clearRegistrationTimer();
      finalizeBrowserMediaTelemetry();
      if (invitationRef.current) void stopInvitation(invitationRef.current);
      invitationRef.current = null;
      mediaStream?.getTracks().forEach((track) => track.stop());
      clearRemoteAudio();
      void stopCurrentRegistration();
    };
  }, [audioSetup.processingProfile, audioSetup.selectedInputId, user?.id, Boolean(deskControl)]);

  return {
    ...runtime,
    ...(deskControl ? { deskSession } : {}),
    audioSetup,
    refreshAudioDevices,
    runAudioCheck,
    selectMicrophone,
    selectSpeaker,
    setMicrophoneProcessingProfile
  };

  async function retryRemoteAudio() {
    const audio = remoteAudioRef.current;
    if (!audio) {
      return;
    }
    setRuntime((current) => ({ ...current, audioPlaybackState: "starting" }));
    try {
      await audio.play();
      if (remoteAudioRef.current === audio) {
        setRuntime((current) => ({ ...current, audioPlaybackState: "playing" }));
      }
    } catch {
      if (remoteAudioRef.current === audio) {
        setRuntime((current) => ({ ...current, audioPlaybackState: "blocked" }));
      }
    }
  }

  async function attachRemoteAudio(invitation: Invitation, isCurrent: () => boolean) {
    const handler = invitation.sessionDescriptionHandler as
      | {
          peerConnection?: RTCPeerConnection;
        }
      | undefined;
    const peerConnection = handler?.peerConnection;
    if (!peerConnection) {
      setRuntime((current) => ({
        ...current,
        audioPlaybackState: "unavailable",
        error: "The browser did not expose a remote audio connection for this call"
      }));
      return;
    }

    const remoteStream = new MediaStream();
    peerConnection.getReceivers().forEach((receiver) => {
      if (receiver.track) {
        remoteStream.addTrack(receiver.track);
        stopBrowserRingbackOnRemoteAudio(receiver.track, stopBrowserRingback);
      }
    });

    const audio = remoteAudioRef.current ?? document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = remoteStream;
    await applyAudioOutput(audio, selectedOutputRef.current).catch(() => undefined);
    if (!remoteAudioRef.current) {
      audio.style.display = "none";
      document.body.appendChild(audio);
      remoteAudioRef.current = audio;
    }
    setRuntime((current) => ({ ...current, audioPlaybackState: "starting" }));
    try {
      await audio.play();
      if (isCurrent() && remoteAudioRef.current === audio) {
        setRuntime((current) => ({ ...current, audioPlaybackState: "playing" }));
      }
    } catch {
      if (isCurrent() && remoteAudioRef.current === audio) {
        setRuntime((current) => ({ ...current, audioPlaybackState: "blocked" }));
      }
    }
  }

  function clearRemoteAudio() {
    stopBrowserRingback();
    if (!remoteAudioRef.current) {
      return;
    }
    remoteAudioRef.current.srcObject = null;
    remoteAudioRef.current.remove();
    remoteAudioRef.current = null;
  }

  function startBrowserMediaTelemetry(invitation: Invitation) {
    finalizeBrowserMediaTelemetry();
    const callId = invitation.request.getHeader("X-Outbound-Dialer-Call-ID");
    const peerConnection = getPeerConnection(invitation);
    if (!callId || !uuidPattern.test(callId) || !peerConnection) {
      return;
    }

    const active: ActiveBrowserMediaTelemetry = {
      callId,
      legUuid: invitation.request.getHeader("X-Outbound-Dialer-Leg-ID") || undefined,
      collector: new BrowserMediaTelemetryCollector(peerConnection),
      intervalId: 0,
      sampling: false
    };
    const sample = async () => {
      if (active.sampling || browserMediaTelemetryRef.current !== active) return;
      active.sampling = true;
      try {
        await active.collector.sample();
        const snapshot = active.collector.snapshot();
        if (snapshot && snapshot.sampleCount % mediaTelemetryUploadEverySamples === 0) {
          void submitBrowserMediaTelemetry(active.callId, snapshot, active.legUuid).catch(() => undefined);
        }
      } finally {
        active.sampling = false;
      }
    };
    active.intervalId = window.setInterval(() => void sample(), mediaTelemetrySampleIntervalMs);
    browserMediaTelemetryRef.current = active;
    void sample();
  }

  function finalizeBrowserMediaTelemetry() {
    const active = browserMediaTelemetryRef.current;
    if (!active) return;
    browserMediaTelemetryRef.current = null;
    window.clearInterval(active.intervalId);
    void active.collector
      .sample()
      .catch(() => undefined)
      .then(() => {
        const snapshot = active.collector.snapshot();
        if (snapshot) {
          return submitBrowserMediaTelemetry(active.callId, snapshot, active.legUuid).catch(() => undefined);
        }
        return undefined;
      });
  }
}

function getPeerConnection(invitation: Invitation): RTCPeerConnection | null {
  const handler = invitation.sessionDescriptionHandler as
    | {
        peerConnection?: RTCPeerConnection;
      }
    | undefined;
  return handler?.peerConnection ?? null;
}

function stopBrowserRingbackOnRemoteAudio(track: MediaStreamTrack, stopBrowserRingback: () => void) {
  if (track.muted === false) {
    stopBrowserRingback();
    return;
  }
  track.addEventListener?.("unmute", stopBrowserRingback, { once: true });
}

function loadAudioSetup(): AudioSetupRuntime {
  if (typeof window === "undefined") return initialAudioSetup;
  const storedProfile = window.localStorage.getItem(audioProfileStorageKey);
  const processingProfile: MicrophoneProcessingProfile =
    storedProfile === "headset" || storedProfile === "natural" ? storedProfile : "office";
  return {
    ...initialAudioSetup,
    processingProfile,
    selectedInputId: window.localStorage.getItem(audioInputStorageKey) ?? "",
    selectedOutputId: window.localStorage.getItem(audioOutputStorageKey) ?? ""
  };
}

function persistPreference(key: string, value: string) {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(key, value);
  else window.localStorage.removeItem(key);
}

function reconcileAudioDevices(current: AudioSetupRuntime, devices: MediaDeviceInfo[]): AudioSetupRuntime {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  const inputDevices = toDeviceOptions(inputs, "Microphone");
  const outputDevices = toDeviceOptions(outputs, "Speaker");
  const selectedInputId = inputs.some((device) => device.deviceId === current.selectedInputId)
    ? current.selectedInputId
    : "";
  const selectedOutputId = outputs.some((device) => device.deviceId === current.selectedOutputId)
    ? current.selectedOutputId
    : "";
  if (selectedInputId !== current.selectedInputId) persistPreference(audioInputStorageKey, selectedInputId);
  if (selectedOutputId !== current.selectedOutputId)
    persistPreference(audioOutputStorageKey, selectedOutputId);
  return { ...current, inputDevices, outputDevices, selectedInputId, selectedOutputId };
}

function toDeviceOptions(devices: MediaDeviceInfo[], fallback: string): AudioDeviceOption[] {
  return devices.map((device, index) => ({
    deviceId: device.deviceId,
    label: device.label || `${fallback} ${index + 1}`
  }));
}

function firstAudioTrack(stream: MediaStream): MediaStreamTrack | undefined {
  return stream.getAudioTracks?.()[0] ?? stream.getTracks()[0];
}

async function applyAudioOutput(audio: HTMLAudioElement, deviceId: string): Promise<void> {
  const sinkable = audio as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
  if (!sinkable.setSinkId) return;
  await sinkable.setSinkId(deviceId || "default");
}

async function measureMicrophoneSignal(
  stream: MediaStream,
  onLevel: (level: number) => void
): Promise<{ clippedSamples: number; maxPeak: number; maxRms: number; totalSamples: number }> {
  if (typeof AudioContext === "undefined") {
    throw new Error("This browser cannot analyze microphone levels");
  }
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let clippedSamples = 0;
  let maxPeak = 0;
  let maxRms = 0;
  let totalSamples = 0;
  const startedAt = performance.now();

  try {
    while (performance.now() - startedAt < audioCheckDurationMs) {
      analyser.getFloatTimeDomainData(samples);
      let squareTotal = 0;
      let framePeak = 0;
      for (const sample of samples) {
        const absolute = Math.abs(sample);
        squareTotal += sample * sample;
        framePeak = Math.max(framePeak, absolute);
        if (absolute >= 0.995) clippedSamples += 1;
      }
      const rms = Math.sqrt(squareTotal / samples.length);
      maxPeak = Math.max(maxPeak, framePeak);
      maxRms = Math.max(maxRms, rms);
      totalSamples += samples.length;
      onLevel(Math.min(1, Math.max(rms * 4, framePeak)));
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
  } finally {
    source.disconnect();
    analyser.disconnect();
    await context.close().catch(() => undefined);
  }
  return { clippedSamples, maxPeak, maxRms, totalSamples };
}

async function gatherIceCandidateTypes(iceServers: RTCIceServer[]): Promise<Set<string>> {
  if (typeof RTCPeerConnection === "undefined") return new Set();
  const peerConnection = new RTCPeerConnection({ iceServers });
  const candidateTypes = new Set<string>();
  try {
    peerConnection.createDataChannel("audio-readiness");
    peerConnection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      const type =
        event.candidate.type || /\btyp\s+(host|srflx|prflx|relay)\b/.exec(event.candidate.candidate)?.[1];
      if (type) candidateTypes.add(type);
    });
    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    await new Promise<void>((resolve) => {
      if (peerConnection.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const timeout = window.setTimeout(resolve, iceGatheringTimeoutMs);
      peerConnection.addEventListener(
        "icegatheringstatechange",
        () => {
          if (peerConnection.iceGatheringState === "complete") {
            window.clearTimeout(timeout);
            resolve();
          }
        },
        { once: false }
      );
    });
    return candidateTypes;
  } finally {
    peerConnection.close();
  }
}

export const __testing = {
  applyAudioOutput,
  reconcileAudioDevices,
  formatRegisterRejectError,
  stopBrowserRingbackOnRemoteAudio,
  stopSoftphoneRegistration,
  toCallIdleRuntime,
  toRegistrationFailureRuntime
};
