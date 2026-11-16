import { createHash } from "node:crypto";
import { z } from "zod";
import {
  coordinationErrorCodes,
  inboundPhases,
  offerStates,
  transferStates,
  type CreateDeskSessionRequest,
  type UpdateDeskSessionRequest,
  type DeskMutationRequest,
  type CreateTransferRequest,
  type StartNextCallRequest,
  type StartManualCallRequest,
  type StartLeadCallRequest,
  type DeskCoordination,
  type SaveInboundNumberRequest,
  type SaveInboundQueueRequest,
  type SaveInboundFlowRequest,
  type OperationState,
  type AcceptCallOfferResponse,
  type CoordinationMutationResponse
} from "@outbound-dialer/shared";
import {
  inboundFlowVersionSchema,
  inboundQueueConfigurationSchema,
  normalizeInboundNumber
} from "./inbound-configuration.js";

// Revisions/generations are PostgreSQL bigint decimal strings, never JS numbers.
export const deskRevisionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine(
    (value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
    "Revision exceeds PostgreSQL bigint"
  );
const uuid = z.guid();
const mutationFields = {
  deskSessionId: uuid,
  expectedRevision: deskRevisionSchema,
  bindingGeneration: deskRevisionSchema,
  idempotencyKey: uuid
};
export const deskMutationSchema = z.object(mutationFields).strict() satisfies z.ZodType<DeskMutationRequest>;
export const manualStartIntentSchema = z
  .object({ ...mutationFields, startReason: z.literal("manual") })
  .strict();
export const outboundStartIntentSchema = z.discriminatedUnion("startReason", [
  manualStartIntentSchema,
  z.object({ ...mutationFields, startReason: z.literal("automatic"), sourceCallId: uuid }).strict()
]);
export const startNextCallSchema = z
  .object({ campaignId: uuid.optional(), intent: outboundStartIntentSchema.optional() })
  .strict() satisfies z.ZodType<StartNextCallRequest>;
export const startManualCallSchema = z
  .object({
    phoneNumber: z.string().min(3),
    campaignId: uuid.optional(),
    intent: manualStartIntentSchema.optional()
  })
  .strict() satisfies z.ZodType<StartManualCallRequest>;
export const startLeadCallSchema = z
  .object({
    confirmCompletedLead: z.boolean().optional(),
    confirmRetryWait: z.boolean().optional(),
    intent: manualStartIntentSchema.optional()
  })
  .strict() satisfies z.ZodType<StartLeadCallRequest>;
export const createDeskSessionSchema = z
  .object({
    idempotencyKey: uuid,
    expectedRevision: deskRevisionSchema.nullable(),
    campaignId: uuid.nullable()
  })
  .strict() satisfies z.ZodType<CreateDeskSessionRequest>;
export const updateDeskSessionSchema = z
  .object({ ...mutationFields, campaignId: uuid.nullable(), ready: z.boolean() })
  .strict() satisfies z.ZodType<UpdateDeskSessionRequest>;
export const createTransferSchema = z
  .object({ ...mutationFields, recipientAgentId: uuid })
  .strict() satisfies z.ZodType<CreateTransferRequest>;
const adminMutationFields = { idempotencyKey: uuid, expectedRevision: deskRevisionSchema.nullable() };
export const inboundAdminMutationSchema = z.object(adminMutationFields).strict();
export const saveInboundNumberSchema = z
  .object({
    ...adminMutationFields,
    label: z.string().trim().min(1).max(160),
    did: z.string().transform((value, ctx) => {
      try {
        return normalizeInboundNumber(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid international DID" });
        return z.NEVER;
      }
    }),
    queueId: uuid,
    enabled: z.boolean()
  })
  .strict() satisfies z.ZodType<SaveInboundNumberRequest>;
export const saveInboundQueueSchema = z
  .object({
    ...adminMutationFields,
    name: z.string().trim().min(1).max(160),
    campaignId: uuid,
    waitingRecordingId: uuid.nullable(),
    noAnswerFlowVersionId: uuid.nullable(),
    configuration: inboundQueueConfigurationSchema
  })
  .strict() satisfies z.ZodType<SaveInboundQueueRequest>;
export const saveInboundFlowSchema = z
  .object({
    enabled: z.boolean().default(true),
    ...adminMutationFields,
    campaignId: uuid,
    name: z.string().trim().min(1).max(160),
    definition: inboundFlowVersionSchema
  })
  .strict() satisfies z.ZodType<SaveInboundFlowRequest>;
const action = z.object({ allowed: z.boolean(), reason: z.string().nullable() }).strict();
export const deskSessionSnapshotSchema = z
  .object({
    id: uuid,
    revision: deskRevisionSchema,
    bindingGeneration: deskRevisionSchema,
    campaignId: uuid.nullable(),
    endpointVerified: z.boolean(),
    ready: z.boolean(),
    expiresAt: z.iso.datetime({ offset: true })
  })
  .strict()
  .refine((value) => !value.ready || value.endpointVerified, "Ready requires verified endpoint");
export const callOfferSnapshotSchema = z
  .object({
    id: uuid,
    callId: uuid,
    kind: z.enum(["inbound", "transfer"]),
    transferId: uuid.nullable(),
    state: z.enum(offerStates),
    deadlineAt: z.iso.datetime({ offset: true }),
    campaignId: uuid,
    callingNumber: z.string(),
    closureReason: z.string().nullable()
  })
  .strict()
  .refine(
    (value) => (value.kind === "transfer") === (value.transferId !== null),
    "Transfer offer requires transfer identity"
  )
  .refine(
    (value) => (value.state === "pending") === (value.closureReason === null),
    "Closed offers require a reason"
  )
  .refine(
    (value) =>
      value.state !== "ignored" ||
      (value.kind === "inbound" &&
        ["user_ignored", "manual_outbound_started"].includes(value.closureReason ?? "")),
    "Ignore is an inbound exclusion"
  )
  .refine((value) => value.state !== "declined" || value.kind === "transfer", "Decline is transfer-only")
  .refine(
    (value) => value.state !== "expired" || value.closureReason === "deadline_elapsed",
    "Expiry retains its own reason"
  );
export const transferSnapshotSchema = z
  .object({
    id: uuid,
    callId: uuid,
    sourceAgentId: uuid,
    recipientAgentId: uuid,
    state: z.enum(transferStates),
    deadlineAt: z.iso.datetime({ offset: true })
  })
  .strict();
const intentIdentity = { id: uuid, sourceCallId: uuid };
export const deferredAutoNextIntentSnapshotSchema = z
  .object({
    ...intentIdentity,
    state: z.literal("deferred"),
    reason: z.literal("incoming_pending"),
    callId: z.null()
  })
  .strict();
export const autoNextIntentSnapshotSchema = z.discriminatedUnion("state", [
  z.object({ ...intentIdentity, state: z.literal("pending"), reason: z.null(), callId: z.null() }).strict(),
  deferredAutoNextIntentSnapshotSchema,
  z.object({ ...intentIdentity, state: z.literal("started"), reason: z.null(), callId: uuid }).strict(),
  z
    .object({ ...intentIdentity, state: z.literal("canceled"), reason: z.string().min(1), callId: z.null() })
    .strict()
]);
export const deskCoordinationSchema = z
  .object({
    contractVersion: z.literal(1),
    revision: deskRevisionSchema,
    session: deskSessionSnapshotSchema.nullable(),
    slot: z
      .object({
        state: z.enum(["free", "reserved", "connecting", "active", "releasing", "uncertain"]),
        callId: uuid.nullable(),
        reservationId: uuid.nullable(),
        generation: deskRevisionSchema
      })
      .strict(),
    offer: callOfferSnapshotSchema.nullable(),
    transfer: transferSnapshotSchema.nullable(),
    autoNextIntent: autoNextIntentSnapshotSchema.nullable(),
    actions: z
      .object({ manualStart: action, autoNext: action, accept: action, ignore: action, transfer: action })
      .strict()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.slot.state === "free"
        ? value.slot.callId !== null || value.slot.reservationId !== null
        : value.slot.reservationId === null
    ) {
      ctx.addIssue({ code: "custom", message: "Slot state/identity mismatch" });
    }
    if (
      value.autoNextIntent?.state === "deferred" &&
      (value.actions.autoNext.allowed || value.actions.autoNext.reason !== "incoming_pending")
    ) {
      ctx.addIssue({ code: "custom", message: "Deferred automatic work cannot be eligible" });
    }
  }) satisfies z.ZodType<DeskCoordination>;
export const coordinationErrorSchema = z
  .object({
    message: z.string(),
    code: z.enum(coordinationErrorCodes),
    revision: deskRevisionSchema.nullable()
  })
  .strict();
export const acceptCallOfferResponseSchema = z
  .object({
    status: z.literal("connecting"),
    revision: deskRevisionSchema,
    callId: uuid,
    operationId: uuid,
    offerId: uuid
  })
  .strict() satisfies z.ZodType<AcceptCallOfferResponse>;
export const coordinationMutationResponseSchema = z.discriminatedUnion("status", [
  acceptCallOfferResponseSchema,
  z
    .object({ status: z.literal("started"), revision: deskRevisionSchema, callId: uuid, operationId: uuid })
    .strict(),
  z
    .object({
      status: z.literal("deferred"),
      revision: deskRevisionSchema,
      reason: z.literal("incoming_pending"),
      intent: deferredAutoNextIntentSnapshotSchema
    })
    .strict(),
  z.object({ status: z.literal("applied"), revision: deskRevisionSchema }).strict()
]) satisfies z.ZodType<CoordinationMutationResponse>;
export const inboundPhaseSchema = z.enum(inboundPhases);

/** Pure protocol oracle. Actual stored replay, locks and authorization belong to C/E/G. */
export function requestFingerprint(
  method: string,
  route: string,
  resourceId: string | null,
  payload: unknown
): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key, child]) => key !== "idempotencyKey" && child !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)])
      );
    return value;
  }
  // Call only with validated/normalized JSON. Exclude retry key; include revisions and source.
  const body = payload as Record<string, unknown>;
  const { idempotencyKey: _key, ...withoutKey } = body;
  void _key;
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({ version: 1, method: method.toUpperCase(), route, resourceId, payload: withoutKey })
      )
    )
    .digest("hex");
}
export function idempotencyScope(
  actorUserId: string,
  method: string,
  route: string,
  resourceId: string | null
): string {
  return `v1:${createHash("sha256")
    .update(JSON.stringify([actorUserId, method.toUpperCase(), route, resourceId]))
    .digest("hex")}`;
}
export function resolveRequestReplay(
  stored: { scope: string; key: string; fingerprint: string; state: OperationState; result: unknown } | null,
  request: { scope: string; key: string; fingerprint: string }
):
  | { status: "new" }
  | { status: "conflict" }
  | { status: "pending"; state: "pending" | "executing" | "uncertain" }
  | { status: "replay"; result: unknown } {
  if (!stored || stored.scope !== request.scope || stored.key !== request.key) return { status: "new" };
  if (stored.fingerprint !== request.fingerprint) return { status: "conflict" };
  if (stored.state === "pending" || stored.state === "executing" || stored.state === "uncertain")
    return { status: "pending", state: stored.state };
  return { status: "replay", result: stored.result };
}

export function canTransition<State extends string>(
  table: Record<State, readonly State[]>,
  from: State,
  to: State
): boolean {
  return from === to || table[from].includes(to);
}
