import { useEffect, useRef, useState } from "react";
import { Invitation, Registerer, RegistererState, SessionState, UserAgent } from "sip.js";
import type { PublicUser, SupervisorMode } from "./types";
import { fetchSupervisorProvisioning } from "./api";
import { buildMicrophoneConstraints } from "./audio-setup";
import type { MicrophoneProcessingProfile } from "./audio-setup";

export interface SupervisorSoftphoneRuntime {
  registered: boolean;
  state: "idle" | "registering" | "registered" | "failed";
  callState: "none" | "answering" | "active";
  mode: SupervisorMode | null;
  sessionId: string | null;
  microphoneActive: boolean;
  audioPlaybackState: "idle" | "starting" | "playing" | "blocked" | "unavailable";
  error: string | null;
  retryRemoteAudio: () => Promise<void>;
}

const idleRuntime: SupervisorSoftphoneRuntime = {
  registered: false,
  state: "idle",
  callState: "none",
  mode: null,
  sessionId: null,
  microphoneActive: false,
  audioPlaybackState: "idle",
  error: null,
  retryRemoteAudio: async () => undefined
};

const registrationTimeoutMs = 20_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sipDiagnosticsEnabled = import.meta.env.DEV || import.meta.env.VITE_SIP_DIAGNOSTICS === "true";

export function useSupervisorSoftphone(user: PublicUser | null): SupervisorSoftphoneRuntime {
  const generationRef = useRef(0);
  const invitationRef = useRef<Invitation | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [runtime, setRuntime] = useState<SupervisorSoftphoneRuntime>(idleRuntime);

  async function retryRemoteAudio() {
    const audio = remoteAudioRef.current;
    if (!audio) return;
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

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!user) {
      setRuntime(idleRuntime);
      return;
    }

    let cancelled = false;
    let registerer: Registerer | null = null;
    let userAgent: UserAgent | null = null;
    let timer: number | null = null;
    const isCurrent = () => !cancelled && generationRef.current === generation;
    const actions = { retryRemoteAudio };

    const clearAudio = () => {
      const audio = remoteAudioRef.current;
      if (!audio) return;
      audio.srcObject = null;
      audio.remove();
      remoteAudioRef.current = null;
    };

    const attachRemoteAudio = async (invitation: Invitation) => {
      const handler = invitation.sessionDescriptionHandler as
        { peerConnection?: RTCPeerConnection } | undefined;
      const peerConnection = handler?.peerConnection;
      if (!peerConnection) {
        setRuntime((current) => ({
          ...current,
          audioPlaybackState: "unavailable",
          error: "The browser did not expose the supervisor audio connection"
        }));
        return;
      }
      const stream = new MediaStream();
      peerConnection.getReceivers().forEach((receiver) => {
        if (receiver.track) stream.addTrack(receiver.track);
      });
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.style.display = "none";
      audio.srcObject = stream;
      document.body.appendChild(audio);
      remoteAudioRef.current = audio;
      const outputId = readStorage("outbound_dialer_audio_output_id");
      const sinkable = audio as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
      await sinkable.setSinkId?.(outputId || "default").catch(() => undefined);
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
    };

    const fail = (message: string) => {
      if (!isCurrent()) return;
      setRuntime({
        ...idleRuntime,
        state: "failed",
        error: message,
        ...actions
      });
    };

    const register = async () => {
      try {
        setRuntime({ ...idleRuntime, state: "registering", ...actions });
        const provisioning = await fetchSupervisorProvisioning();
        if (!isCurrent()) return;
        const uri = UserAgent.makeURI(provisioning.sipUri);
        if (!uri) throw new Error("Invalid supervisor SIP URI");
        userAgent = new UserAgent({
          authorizationPassword: provisioning.sipPassword,
          authorizationUsername: provisioning.sipUsername,
          displayName: provisioning.displayName,
          logBuiltinEnabled: sipDiagnosticsEnabled,
          logLevel: sipDiagnosticsEnabled ? "debug" : "warn",
          delegate: {
            onInvite: (invitation) => {
              if (!isCurrent() || invitationRef.current) {
                void invitation.reject().catch(() => undefined);
                return;
              }
              const sessionId = invitation.request.getHeader("X-Outbound-Dialer-Supervisor-Session-ID");
              const mode = parseSupervisorMode(
                invitation.request.getHeader("X-Outbound-Dialer-Supervisor-Mode")
              );
              if (!sessionId || !uuidPattern.test(sessionId) || !mode) {
                void invitation.reject().catch(() => undefined);
                return;
              }
              invitationRef.current = invitation;
              setRuntime((current) => ({
                ...current,
                callState: "answering",
                mode,
                sessionId,
                microphoneActive: false,
                audioPlaybackState: "idle",
                error: null
              }));
              invitation.stateChange.addListener((state) => {
                if (!isCurrent()) return;
                if (state === SessionState.Established) {
                  setRuntime((current) => ({
                    ...current,
                    callState: "active",
                    microphoneActive: mode !== "listen",
                    error: null
                  }));
                  void attachRemoteAudio(invitation);
                }
                if (state === SessionState.Terminated) {
                  invitationRef.current = null;
                  clearAudio();
                  setRuntime((current) => ({
                    ...current,
                    callState: "none",
                    mode: null,
                    sessionId: null,
                    microphoneActive: false,
                    audioPlaybackState: "idle"
                  }));
                }
              });

              const microphoneConstraints = mode === "listen" ? false : loadSupervisorMicrophoneConstraints();
              void invitation
                .accept({
                  sessionDescriptionHandlerOptions: {
                    constraints: { audio: microphoneConstraints, video: false }
                  }
                })
                .catch((error: unknown) => {
                  if (!isCurrent()) return;
                  invitationRef.current = null;
                  clearAudio();
                  setRuntime((current) => ({
                    ...current,
                    callState: "none",
                    mode: null,
                    sessionId: null,
                    microphoneActive: false,
                    audioPlaybackState: "idle",
                    error: error instanceof Error ? error.message : "The supervisor media connection failed"
                  }));
                });
            },
            onDisconnect: (error) => {
              fail(error instanceof Error ? error.message : "Supervisor SIP transport disconnected");
            }
          },
          transportOptions: {
            server: provisioning.websocketUrl,
            traceSip: sipDiagnosticsEnabled
          },
          uri,
          sessionDescriptionHandlerFactoryOptions: {
            peerConnectionConfiguration: { iceServers: provisioning.iceServers },
            constraints: { audio: false, video: false }
          }
        });
        registerer = new Registerer(userAgent);
        registerer.stateChange.addListener((state) => {
          if (!isCurrent()) return;
          if (state === RegistererState.Registered) {
            if (timer) window.clearTimeout(timer);
            timer = null;
            setRuntime((current) => ({
              ...current,
              registered: true,
              state: "registered",
              error: null
            }));
          } else if (state === RegistererState.Terminated) {
            fail("Supervisor SIP registration terminated");
          }
        });
        await userAgent.start();
        if (!isCurrent()) return;
        timer = window.setTimeout(() => fail("Supervisor SIP registration timed out"), registrationTimeoutMs);
        await registerer.register({
          requestDelegate: {
            onReject: (response) => fail(`Supervisor REGISTER rejected ${response.message.statusCode}`)
          }
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : "Supervisor phone registration failed");
      }
    };

    void register();
    return () => {
      cancelled = true;
      generationRef.current += 1;
      if (timer) window.clearTimeout(timer);
      const invitation = invitationRef.current;
      invitationRef.current = null;
      if (invitation) void stopInvitation(invitation);
      clearAudio();
      void registerer?.unregister().catch(() => undefined);
      void userAgent?.stop().catch(() => undefined);
    };
  }, [user?.id]);

  return { ...runtime, retryRemoteAudio };
}

function parseSupervisorMode(value: string | undefined): SupervisorMode | null {
  return value === "listen" || value === "whisper" || value === "join" ? value : null;
}

function loadSupervisorMicrophoneConstraints(): MediaTrackConstraints {
  const storedProfile = readStorage("outbound_dialer_audio_processing_profile");
  const profile: MicrophoneProcessingProfile =
    storedProfile === "headset" || storedProfile === "natural" ? storedProfile : "office";
  return buildMicrophoneConstraints(profile, readStorage("outbound_dialer_audio_input_id"));
}

function readStorage(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

async function stopInvitation(invitation: Invitation): Promise<void> {
  if (invitation.state === SessionState.Established) {
    await invitation.bye().catch(() => undefined);
    return;
  }
  await invitation.reject().catch(() => undefined);
}

export const __testing = {
  loadSupervisorMicrophoneConstraints,
  parseSupervisorMode
};
