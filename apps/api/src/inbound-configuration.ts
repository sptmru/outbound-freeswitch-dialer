import { z } from "zod";
import { normalizePhoneNumber } from "./dashboard/phone.js";

// Reuse strict phone validation after the existing input normalization. No SIP URI parsing.
export function normalizeInboundNumber(value: string, defaultCountryCode?: string): string {
  const result = normalizePhoneNumber(value, defaultCountryCode);
  if (!result.ok) throw new Error(result.reason);
  return result.number;
}

export const inboundQueueConfigurationSchema = z
  .object({
    offerTimeoutMs: z.number().int().min(5000).max(30000).default(15000),
    queueTimeoutMs: z.number().int().min(15000).max(300000).default(60000),
    connectTimeoutMs: z.number().int().min(6000).max(15000).default(10000),
    transferTimeoutMs: z.number().int().min(5000).max(30000).default(20000),
    maxWaitingCalls: z.number().int().min(1).max(200).default(40),
    overflowPolicy: z.enum(["reject", "flow"]).default("reject"),
    overflowFlowVersionId: z.uuid().nullable().default(null)
  })
  .strict()
  .refine((value) => value.connectTimeoutMs < value.queueTimeoutMs, "Connect must precede queue deadline")
  .refine(
    (value) => (value.overflowPolicy === "flow") === (value.overflowFlowVersionId !== null),
    "Overflow flow is required only for flow policy"
  );

const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("play_audio"),
      recordingId: z.uuid(),
      timeoutMs: z.number().int().min(1000).max(60000)
    })
    .strict(),
  z
    .object({
      type: z.literal("forward_external"),
      target: z.string().transform((value, ctx) => {
        try {
          return normalizeInboundNumber(value);
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid international forwarding target" });
          return z.NEVER;
        }
      }),
      timeoutMs: z.number().int().min(5000).max(30000)
    })
    .strict(),
  z.object({ type: z.literal("hangup") }).strict()
]);

export const inboundFlowVersionSchema = z
  .object({
    flowTimeoutMs: z.number().int().min(1000).max(180000).default(90000),
    actions: z.array(actionSchema).min(1).max(3)
  })
  .strict()
  .superRefine((value, ctx) => {
    let total = 0;
    let plays = 0;
    let forwards = 0;
    value.actions.forEach((action, index) => {
      if (action.type === "hangup") {
        if (index !== value.actions.length - 1)
          ctx.addIssue({ code: "custom", message: "Hangup must be last" });
      } else {
        total += action.timeoutMs;
        if (action.type === "play_audio") plays++;
        else forwards++;
      }
    });
    if (plays > 2 || forwards > 1 || total > value.flowTimeoutMs) {
      ctx.addIssue({ code: "custom", message: "Flow exceeds action or duration budget" });
    }
  });
