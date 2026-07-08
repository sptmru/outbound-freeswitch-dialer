import { useEffect, useState } from "react";
import { Registerer, UserAgent } from "sip.js";
import { fetchSoftphoneProvisioning } from "./api";
import type { PublicUser } from "./types";

export type SoftphoneRuntimeState =
  | "idle"
  | "requesting_microphone"
  | "registering"
  | "registered"
  | "failed";

export interface SoftphoneRuntime {
  registered: boolean;
  microphoneAllowed: boolean;
  state: SoftphoneRuntimeState;
  label: string;
  detail: string;
  error: string | null;
}

const idleRuntime: SoftphoneRuntime = {
  registered: false,
  microphoneAllowed: false,
  state: "idle",
  label: "Softphone idle",
  detail: "Sign in to register this browser",
  error: null
};

export function useSoftphoneRegistration(user: PublicUser | null): SoftphoneRuntime {
  const [runtime, setRuntime] = useState<SoftphoneRuntime>(idleRuntime);

  useEffect(() => {
    if (!user) {
      setRuntime(idleRuntime);
      return;
    }

    let cancelled = false;
    let mediaStream: MediaStream | null = null;
    let registerer: Registerer | null = null;
    let userAgent: UserAgent | null = null;

    async function register() {
      try {
        setRuntime({
          registered: false,
          microphoneAllowed: false,
          state: "requesting_microphone",
          label: "Mic permission",
          detail: "Waiting for browser access",
          error: null
        });

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Browser microphone access is unavailable");
        }

        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) {
          return;
        }

        setRuntime({
          registered: false,
          microphoneAllowed: true,
          state: "registering",
          label: "Registering",
          detail: "Connecting this browser to the calling server",
          error: null
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
          transportOptions: {
            server: provisioning.websocketUrl
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
        await userAgent.start();
        await registerer.register();

        if (cancelled) {
          return;
        }

        setRuntime({
          registered: true,
          microphoneAllowed: true,
          state: "registered",
          label: "Softphone registered",
          detail: `${provisioning.sipUsername}@${provisioning.domain}`,
          error: null
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setRuntime({
          registered: false,
          microphoneAllowed: Boolean(mediaStream),
          state: "failed",
          label: "Softphone offline",
          detail: "Registration failed",
          error: error instanceof Error ? error.message : "Softphone registration failed"
        });
      }
    }

    void register();

    return () => {
      cancelled = true;
      mediaStream?.getTracks().forEach((track) => track.stop());
      void registerer?.unregister().catch(() => undefined);
      void userAgent?.stop().catch(() => undefined);
    };
  }, [user?.id]);

  return runtime;
}
