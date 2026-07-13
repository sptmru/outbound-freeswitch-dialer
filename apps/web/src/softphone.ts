import { useEffect, useRef, useState } from "react";
import { Invitation, Registerer, RegistererState, SessionState, UserAgent } from "sip.js";
import { fetchSoftphoneProvisioning } from "./api";
import type { PublicUser } from "./types";

export type SoftphoneRuntimeState =
  "idle" | "requesting_microphone" | "registering" | "registered" | "failed";

export interface SoftphoneRuntime {
  registered: boolean;
  microphoneAllowed: boolean;
  state: SoftphoneRuntimeState;
  callState: "none" | "incoming" | "answering" | "active";
  label: string;
  detail: string;
  error: string | null;
  incomingCallLabel: string | null;
  answerIncomingCall: () => Promise<void>;
  declineIncomingCall: () => Promise<void>;
  hangUpSoftphoneCall: () => Promise<void>;
}

const idleRuntime: SoftphoneRuntime = {
  registered: false,
  microphoneAllowed: false,
  state: "idle",
  callState: "none",
  label: "Softphone idle",
  detail: "Sign in to register this browser",
  error: null,
  incomingCallLabel: null,
  answerIncomingCall: async () => undefined,
  declineIncomingCall: async () => undefined,
  hangUpSoftphoneCall: async () => undefined
};

const registrationTimeoutMs = 20_000;
const sipDiagnosticsEnabled = import.meta.env.DEV || import.meta.env.VITE_SIP_DIAGNOSTICS === "true";

function toRegistrationFailureRuntime(
  current: SoftphoneRuntime,
  detail: string,
  error: string
): SoftphoneRuntime {
  return {
    ...current,
    registered: false,
    state: "failed",
    callState: "none",
    label: "Softphone offline",
    detail,
    error,
    incomingCallLabel: null
  };
}

function toCallIdleRuntime(current: SoftphoneRuntime, registeredDetail: string): SoftphoneRuntime {
  return {
    ...current,
    callState: "none",
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

export function useSoftphoneRegistration(user: PublicUser | null): SoftphoneRuntime {
  const invitationRef = useRef<Invitation | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [runtime, setRuntime] = useState<SoftphoneRuntime>(idleRuntime);

  async function answerIncomingCall() {
    const invitation = invitationRef.current;
    if (!invitation) {
      return;
    }
    await acceptInvitation(invitation, runtime.incomingCallLabel ?? "Connecting");
  }

  async function acceptInvitation(invitation: Invitation, incomingCallLabel: string) {
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
          audio: true,
          video: false
        }
      }
    });
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
    const invitation = invitationRef.current;
    if (!invitation) {
      return;
    }
    await invitation.bye().catch(async () => {
      await invitation.reject().catch(() => undefined);
    });
    invitationRef.current = null;
    clearRemoteAudio();
    setRuntime((current) => toCallIdleRuntime(current, "Ready for calls"));
  }

  useEffect(() => {
    if (!user) {
      invitationRef.current = null;
      setRuntime(idleRuntime);
      return;
    }

    let cancelled = false;
    let mediaStream: MediaStream | null = null;
    let microphoneAllowed = false;
    let registerer: Registerer | null = null;
    let registrationTimer: number | null = null;
    let userAgent: UserAgent | null = null;
    const clearRegistrationTimer = () => {
      if (registrationTimer) {
        window.clearTimeout(registrationTimer);
        registrationTimer = null;
      }
    };
    const getActions = () => ({
      answerIncomingCall,
      declineIncomingCall,
      hangUpSoftphoneCall
    });
    const failRegistration = (
      detail: string,
      error: string,
      options: { preserveExistingError?: boolean } = {}
    ) => {
      clearRegistrationTimer();
      invitationRef.current = null;
      clearRemoteAudio();
      setRuntime((current) => {
        if (options.preserveExistingError && current.state === "failed" && current.error) {
          return current;
        }
        return toRegistrationFailureRuntime(current, detail, error);
      });
    };

    async function register() {
      try {
        setRuntime({
          registered: false,
          microphoneAllowed: false,
          state: "requesting_microphone",
          callState: "none",
          label: "Mic permission",
          detail: "Waiting for browser access",
          error: null,
          incomingCallLabel: null,
          ...getActions()
        });

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Browser microphone access is unavailable");
        }

        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        microphoneAllowed = true;
        if (cancelled) {
          return;
        }
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;

        setRuntime({
          registered: false,
          microphoneAllowed: true,
          state: "registering",
          callState: "none",
          label: "Registering",
          detail: "Connecting this browser to the calling server",
          error: null,
          incomingCallLabel: null,
          ...getActions()
        });

        const provisioning = await fetchSoftphoneProvisioning();
        const uri = UserAgent.makeURI(provisioning.sipUri);
        if (!uri) {
          throw new Error("Invalid SIP provisioning URI");
        }

        userAgent = new UserAgent({
          authorizationPassword: provisioning.sipPassword,
          authorizationUsername: provisioning.sipUsername,
          displayName: provisioning.displayName,
          logBuiltinEnabled: sipDiagnosticsEnabled,
          logLevel: sipDiagnosticsEnabled ? "debug" : "warn",
          delegate: {
            onInvite: (invitation) => {
              if (invitationRef.current) {
                void invitation.reject();
                return;
              }

              const incomingCallLabel = invitation.remoteIdentity.displayName || "Outbound Dialer Test";
              invitationRef.current = invitation;
              invitation.stateChange.addListener((state) => {
                if (state === SessionState.Established) {
                  attachRemoteAudio(invitation);
                  setRuntime((current) => ({
                    ...current,
                    callState: "active",
                    label: "Softphone call active",
                    detail: incomingCallLabel,
                    error: null,
                    incomingCallLabel
                  }));
                }
                if (state === SessionState.Terminated) {
                  invitationRef.current = null;
                  clearRemoteAudio();
                  setRuntime((current) =>
                    toCallIdleRuntime(current, `${provisioning.sipUsername}@${provisioning.domain}`)
                  );
                }
              });

              void acceptInvitation(invitation, incomingCallLabel).catch((error: unknown) => {
                invitationRef.current = null;
                clearRemoteAudio();
                setRuntime((current) => ({
                  ...toCallIdleRuntime(current, `${provisioning.sipUsername}@${provisioning.domain}`),
                  error: error instanceof Error ? error.message : "Softphone call failed"
                }));
              });
            },
            onDisconnect: (error) => {
              if (cancelled) {
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
            constraints: {
              audio: true,
              video: false
            }
          }
        });
        registerer = new Registerer(userAgent);
        registerer.stateChange.addListener((state) => {
          if (cancelled) {
            return;
          }

          if (state === RegistererState.Registered) {
            clearRegistrationTimer();
            setRuntime((current) => ({
              ...current,
              registered: true,
              microphoneAllowed: true,
              state: "registered",
              label: "Softphone registered",
              detail: `${provisioning.sipUsername}@${provisioning.domain}`,
              error: null
            }));
            return;
          }

          if (state === RegistererState.Unregistered || state === RegistererState.Terminated) {
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
        registrationTimer = window.setTimeout(() => {
          if (cancelled) {
            return;
          }
          setRuntime((current) => {
            if (current.registered || current.state === "registered") {
              return current;
            }
            return {
              ...current,
              registered: false,
              state: "failed",
              label: "Softphone offline",
              detail: "SIP registration timed out",
              error: `No accepted REGISTER response within ${registrationTimeoutMs / 1000}s. Check browser console for SIP.js logs.`
            };
          });
        }, registrationTimeoutMs);
        await registerer.register({
          requestDelegate: {
            onAccept: () => {
              if (cancelled) {
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
              if (cancelled) {
                return;
              }
              failRegistration(
                "SIP registration rejected",
                formatRegisterRejectError(response.message.statusCode, response.message.reasonPhrase)
              );
            }
          }
        });

        if (cancelled) {
          return;
        }

        setRuntime((current) => ({
          ...current,
          registered: false,
          microphoneAllowed: true,
          state: current.state === "registered" ? current.state : "registering",
          label: current.state === "registered" ? current.label : "Registration sent",
          detail: current.state === "registered" ? current.detail : "Waiting for accepted SIP registration",
          error: current.state === "registered" ? null : current.error,
          ...getActions()
        }));
      } catch (error) {
        if (cancelled) {
          return;
        }
        clearRegistrationTimer();
        setRuntime({
          registered: false,
          microphoneAllowed,
          state: "failed",
          callState: "none",
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
      clearRegistrationTimer();
      void invitationRef.current?.bye().catch(() => undefined);
      invitationRef.current = null;
      mediaStream?.getTracks().forEach((track) => track.stop());
      clearRemoteAudio();
      const currentRegisterer = registerer;
      const currentUserAgent = userAgent;
      void stopSoftphoneRegistration(currentRegisterer, currentUserAgent);
    };
  }, [user?.id]);

  return runtime;

  function attachRemoteAudio(invitation: Invitation) {
    const handler = invitation.sessionDescriptionHandler as
      | {
          peerConnection?: RTCPeerConnection;
        }
      | undefined;
    const peerConnection = handler?.peerConnection;
    if (!peerConnection) {
      return;
    }

    const remoteStream = new MediaStream();
    peerConnection.getReceivers().forEach((receiver) => {
      if (receiver.track) {
        remoteStream.addTrack(receiver.track);
      }
    });

    const audio = remoteAudioRef.current ?? document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = remoteStream;
    if (!remoteAudioRef.current) {
      audio.style.display = "none";
      document.body.appendChild(audio);
      remoteAudioRef.current = audio;
    }
    void audio.play().catch(() => undefined);
  }

  function clearRemoteAudio() {
    if (!remoteAudioRef.current) {
      return;
    }
    remoteAudioRef.current.srcObject = null;
    remoteAudioRef.current.remove();
    remoteAudioRef.current = null;
  }
}

export const __testing = {
  formatRegisterRejectError,
  stopSoftphoneRegistration,
  toCallIdleRuntime,
  toRegistrationFailureRuntime
};
