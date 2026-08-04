import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import {
  callOutcomes,
  type AdminAnalyticsResponse,
  type AdminAuditResponse,
  type AdminCampaignListResponse,
  type AdminLiveCallsResponse,
  type AdminOverviewResponse,
  type AdminRecordingListResponse,
  type AdminSystemSettings,
  type AdminUserListResponse,
  type AgentDeskResponse,
  type CallAvmdReview,
  type CallDetailResponse,
  type CallHistoryResponse,
  type CampaignContactListItem,
  type CampaignContactsResponse,
  type CreateCampaignRequest,
  type CreateContactRequest,
  type CreateRecordingResponse,
  type CreateSuppressionRequest,
  type CsvImportDetailResponse,
  type CsvImportFailure,
  type CsvImportHistoryResponse,
  type DeleteResponse,
  type DropVoicemailRequest,
  type EndCallRequest,
  type FreeSwitchDiagnosticsResponse,
  type FreeSwitchSafeTestResponse,
  type FreeSwitchTrunkStatus,
  type ImportCsvRequest,
  type ImportCsvResponse,
  type LeadSummary,
  type ManualCallStatusResponse,
  type ManualDialValidationResponse,
  type MediaTicketResponse,
  type MutationResponse,
  type PublicUser,
  type ResetCampaignLeadsResponse,
  type RetentionRunResponse,
  type SendDtmfRequest,
  type SoftphoneProvisioningResponse,
  type StartLeadCallRequest,
  type StartManualCallRequest,
  type StartNextCallRequest,
  type SupervisorSession,
  type SuppressContactRequest,
  type SuppressionImportResponse,
  type SuppressionListResponse,
  type UpdateAgentAvailabilityRequest,
  type UpdateCallStatusRequest,
  type UpdateCampaignRequest,
  type UpdateSupervisorSessionRequest,
  type UpsertCallAvmdReviewRequest
} from "@outbound-dialer/shared";
import { z } from "zod";
import { requireUser } from "../auth/routes.js";
import { setAgentAvailability } from "../agent-availability.js";
import type { AppConfig } from "../config.js";
import { RuntimeSettingsService, updateSystemSettingsSchema } from "../runtime-settings.js";
import {
  canOriginateCustomerLeg,
  checkFreeSwitchEsl,
  createFreeSwitchUuid,
  sendFreeSwitchApiCommand,
  sendFreeSwitchBgapiCommand
} from "../esl.js";
import { ensureAgentForUser, getSoftphoneProvisioningForUser, toPublicUser } from "../users.js";
import { getCsvImportsPage, getUsersPage } from "./admin-libraries.js";
import { getAdminAnalytics, parseAnalyticsFilters } from "./analytics.js";
import { upsertCallAvmdReview } from "./avmd-reviews.js";
import { browserMediaTelemetrySchema, upsertBrowserMediaTelemetry } from "./browser-media.js";
import {
  campaignExists,
  deleteCampaign,
  getAgentCampaign,
  getAgentCampaignForDialerAction,
  getCampaignOverviewItem,
  getCampaignsPage,
  resetCampaignLeads
} from "./campaigns.js";
import { openCampaignRecordingExport } from "./campaign-recording-export.js";
import {
  createDialerCall,
  createDialerCallFailureMessage,
  dropVoicemailForCall,
  endDialerCall,
  inferAgentEndOutcome,
  sendDtmfForCall,
  syncFreeSwitchOriginate
} from "./calls.js";
import {
  CsvImportError,
  importContactsFromCsv,
  importSuppressionFromCsv,
  isCsvFilename,
  parseCsv
} from "./csv.js";
import { createMediaTicket, verifyMediaTicket, type MediaResourceType } from "./media-tickets.js";
import { validateDialableNumber } from "./manual-dial.js";
import { setManualCallStatus } from "./manual-call-status.js";
import { normalizePhoneNumber } from "./phone.js";
import {
  createRecording,
  deleteRecording,
  getMultipartFieldValue,
  getRecordingsPage,
  getRecordingAudioFile,
  getRecordingContentType,
  getSupportedRecordingExtension,
  normalizeRecordingName,
  parseSingleByteRange,
  parseBooleanField,
  RecordingProcessingError,
  restoreDeletedRecording,
  transcodeRecordingToCanonicalWav,
  setDefaultRecording
} from "./recordings.js";
import {
  buildAdminOverviewResponse,
  buildAgentDeskResponse,
  formatElapsed,
  getActiveCallActions,
  getCallDetail,
  getCallHistoryPage,
  getCallHistoryPageBounds,
  getCallRecordingAudioFile,
  mapCallStatus,
  mapVoicemailSignal,
  type CallHistoryFilters
} from "./responders.js";
import { findSuppression } from "./suppression.js";
import { runRetention } from "./retention.js";
import { runRetentionWithAdvisoryLock } from "./retention-scheduler.js";
import { recordRetentionFailure, recordRetentionSuccess } from "../metrics.js";
import { callPcapPath } from "../pcap-capture.js";
import {
  getAdminLiveCalls,
  getSupervisorProvisioning,
  startSupervisorSession,
  stopSupervisorSession,
  SupervisorActionError,
  updateSupervisorSessionMode
} from "./supervisor.js";

const manualDialValidationSchema = z.object({
  phoneNumber: z.string().min(3),
  campaignId: z.string().uuid().optional()
}) satisfies z.ZodType<StartManualCallRequest>;

const startNextCallSchema = z.object({
  campaignId: z.string().uuid().optional()
}) satisfies z.ZodType<StartNextCallRequest>;

const startLeadCallSchema = z.object({
  confirmCompletedLead: z.boolean().optional(),
  confirmRetryWait: z.boolean().optional()
}) satisfies z.ZodType<StartLeadCallRequest>;

const endCallSchema = z.object({
  campaignId: z.string().uuid().optional()
}) satisfies z.ZodType<EndCallRequest>;

const updateCallStatusSchema = z.object({
  outcome: z.enum(callOutcomes)
}) satisfies z.ZodType<UpdateCallStatusRequest>;

const dropVoicemailSchema = z.object({
  campaignId: z.string().uuid().optional(),
  recordingId: z.string().uuid().optional()
}) satisfies z.ZodType<DropVoicemailRequest>;

const sendDtmfSchema = z.object({
  digit: z.enum(["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]),
  campaignId: z.string().uuid().optional()
}) satisfies z.ZodType<SendDtmfRequest>;

const createCampaignSchema = z.object({
  name: z.string().min(1).max(160),
  status: z.enum(["active", "paused", "draft", "archived"]),
  manualDialingEnabled: z.boolean(),
  callRecordingEnabled: z.boolean(),
  earlyMediaAvmdEnabled: z.boolean(),
  autoAdvanceToNextLeadEnabled: z.boolean().optional()
}) satisfies z.ZodType<CreateCampaignRequest>;

const updateCampaignSchema = z.object({
  name: z.string().min(1).max(160),
  status: z.enum(["active", "paused", "draft", "archived"]),
  manualDialingEnabled: z.boolean(),
  callRecordingEnabled: z.boolean(),
  earlyMediaAvmdEnabled: z.boolean(),
  autoAdvanceToNextLeadEnabled: z.boolean().optional()
}) satisfies z.ZodType<UpdateCampaignRequest>;

const createContactSchema = z.object({
  campaignId: z.string().uuid(),
  name: z.string().min(1).max(160),
  phoneNumber: z.string().min(3).max(64),
  company: z.string().max(160).optional(),
  fields: z
    .array(z.object({ label: z.string().min(1).max(80), value: z.string().max(400) }))
    .max(20)
    .optional()
}) satisfies z.ZodType<CreateContactRequest>;

const createSuppressionSchema = z.object({
  phoneNumber: z.string().min(3).max(64),
  reason: z.string().max(240).optional()
}) satisfies z.ZodType<CreateSuppressionRequest>;

const suppressContactSchema = z.object({
  reason: z.string().max(240).optional()
}) satisfies z.ZodType<SuppressContactRequest>;

const importCsvSchema = z.object({
  filename: z.string().min(1).max(240),
  csvText: z.string().min(1).max(67_108_864)
}) satisfies z.ZodType<ImportCsvRequest>;

const contactsQuerySchema = z.object({
  q: z.string().default(""),
  status: z.enum(["all", "ready", "suppressed", "completed"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
});

const campaignParamsSchema = z.object({
  campaignId: z.string().uuid()
});

const suppressionParamsSchema = z.object({
  suppressionId: z.string().uuid()
});

const recordingParamsSchema = z.object({
  recordingId: z.string().uuid()
});

const recordingAudioQuerySchema = z.object({
  ticket: z.string().min(32).max(200).optional()
});

const callHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().max(160).optional(),
  campaignId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  outcome: z
    .enum([
      "answered",
      "not_answered",
      "busy",
      "failed",
      "voicemail_detected",
      "voicemail_dropped",
      "agent_canceled",
      "customer_hung_up",
      "suppressed"
    ])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  voicemail: z.enum(["drop", "signal"]).optional(),
  recording: z.enum(["available", "missing"]).optional(),
  avmdReview: z.enum(["needs_review", "reviewed", "uncertain"]).optional()
});

const upsertCallAvmdReviewSchema = z.object({
  actualParty: z.enum(["human", "machine", "uncertain"]),
  notes: z.string().max(1000).optional()
}) satisfies z.ZodType<UpsertCallAvmdReviewRequest>;

const suppressionQuerySchema = z.object({
  q: z.string().max(160).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

const adminLibraryQuerySchema = z.object({
  q: z.string().max(160).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

const csvImportLibraryQuerySchema = adminLibraryQuerySchema.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

const csvImportFailuresQuerySchema = z.object({
  failurePage: z.coerce.number().int().min(1).default(1),
  failurePageSize: z.coerce.number().int().min(1).max(100).default(50)
});

const retentionRunSchema = z.object({
  dryRun: z.boolean().default(true)
});

const adminAuditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  actorId: z.string().uuid().optional(),
  method: z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"]).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional()
});

const supervisorSessionParamsSchema = z.object({
  sessionId: z.string().uuid()
});

const updateSupervisorSessionSchema = z.object({
  mode: z.enum(["listen", "whisper", "join"])
}) satisfies z.ZodType<UpdateSupervisorSessionRequest>;

const agentDeskQuerySchema = z.object({
  campaignId: z.string().uuid().optional()
});

const updateAgentAvailabilitySchema = z.object({
  status: z.enum(["available", "paused"]),
  campaignId: z.string().uuid().optional()
}) satisfies z.ZodType<UpdateAgentAvailabilityRequest>;

export function registerDashboardRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pool: pg.Pool,
  runtimeSettings = new RuntimeSettingsService(pool, config)
): void {
  const csvJsonBodyLimit = Math.min(67_108_864, (config.CSV_UPLOAD_MAX_BYTES ?? 5_242_880) * 2 + 65_536);
  const contactRetryPolicy = {
    get maxAttempts() {
      return config.CONTACT_MAX_ATTEMPTS;
    },
    get retryDelaySeconds() {
      return config.CONTACT_RETRY_DELAY_SECONDS;
    }
  };
  app.get("/admin/system-settings", async (request, reply): Promise<AdminSystemSettings | void> => {
    if (!(await requireAdmin(request, reply, config, pool))) return;
    return runtimeSettings.get();
  });
  app.patch("/admin/system-settings", async (request, reply): Promise<AdminSystemSettings | void> => {
    if (!(await requireAdmin(request, reply, config, pool))) return;
    const before = runtimeSettings.get();
    const updated = await runtimeSettings.update(updateSystemSettingsSchema.parse(request.body));
    const changes = Object.fromEntries(
      Object.keys(request.body as object)
        .filter(
          (key) => before[key as keyof AdminSystemSettings] !== updated[key as keyof AdminSystemSettings]
        )
        .map((key) => [
          key,
          {
            from: before[key as keyof AdminSystemSettings],
            to: updated[key as keyof AdminSystemSettings]
          }
        ])
    );
    await pool.query(
      `update admin_audit_events
       set metadata_json = metadata_json || $2::jsonb
       where request_id = $1`,
      [request.id, JSON.stringify({ changes })]
    );
    return updated;
  });
  app.get("/agent/desk", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const query = agentDeskQuerySchema.parse(request.query);
    return buildAgentDeskResponse(pool, toPublicUser(user), query.campaignId, contactRetryPolicy);
  });

  app.patch("/agent/availability", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const input = updateAgentAvailabilitySchema.parse(request.body);
    const publicUser = toPublicUser(user);
    const agent = await ensureAgentForUser(pool, config, publicUser);
    const availability = await setAgentAvailability(pool, agent.id, input.status);
    if (!availability) {
      return reply.code(409).send({ message: "Agent availability could not be updated" });
    }
    return buildAgentDeskResponse(pool, publicUser, input.campaignId, contactRetryPolicy);
  });

  app.get(
    "/agent/softphone/provisioning",
    async (request, reply): Promise<SoftphoneProvisioningResponse | void> => {
      const user = await requireUser(request, config, pool);
      if (!user) {
        return reply.code(401).send({ message: "Unauthorized" });
      }

      return getSoftphoneProvisioningForUser(pool, config, toPublicUser(user));
    }
  );

  app.put("/agent/calls/:callId/browser-media", async (request, reply): Promise<void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const telemetry = browserMediaTelemetrySchema.parse(request.body);
    const saved = await upsertBrowserMediaTelemetry(pool, {
      callId: params.callId,
      userId: user.id,
      telemetry
    });
    if (!saved) {
      return reply.code(404).send({ message: "Call not found" });
    }
    return reply.code(204).send();
  });

  app.get("/admin/overview", async (request, reply): Promise<AdminOverviewResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
    if (user.role !== "admin") {
      return reply.code(403).send({ message: "Admin role required" });
    }

    return buildAdminOverviewResponse(pool, toPublicUser(user), contactRetryPolicy);
  });

  app.get("/admin/analytics", async (request, reply): Promise<AdminAnalyticsResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const filters = parseAnalyticsFilters(request.query);
    return getAdminAnalytics(pool, filters, contactRetryPolicy);
  });

  app.get("/admin/live-calls", async (request, reply): Promise<AdminLiveCallsResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) return;
    return getAdminLiveCalls(pool, user.id);
  });

  app.get(
    "/admin/supervisor/provisioning",
    async (request, reply): Promise<SoftphoneProvisioningResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) return;
      return getSupervisorProvisioning(pool, config, user);
    }
  );

  app.post(
    "/admin/live-calls/:callId/supervisor",
    async (request, reply): Promise<SupervisorSession | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) return;
      const params = z.object({ callId: z.string().uuid() }).parse(request.params);
      try {
        const session = await startSupervisorSession(pool, config, {
          actorUserId: user.id,
          callId: params.callId
        });
        await appendAdminAuditMetadata(pool, request.id, {
          action: "supervisor_started",
          callId: params.callId,
          mode: session.mode,
          supervisorSessionId: session.id
        });
        return reply.code(201).send(session);
      } catch (error) {
        if (error instanceof SupervisorActionError) {
          return reply.code(error.statusCode).send({ message: error.message });
        }
        throw error;
      }
    }
  );

  app.patch(
    "/admin/supervisor-sessions/:sessionId",
    async (request, reply): Promise<SupervisorSession | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) return;
      const params = supervisorSessionParamsSchema.parse(request.params);
      const input = updateSupervisorSessionSchema.parse(request.body);
      try {
        const session = await updateSupervisorSessionMode(pool, config, {
          actorUserId: user.id,
          mode: input.mode,
          sessionId: params.sessionId
        });
        await appendAdminAuditMetadata(pool, request.id, {
          action: "supervisor_mode_changed",
          callId: session.callId,
          mode: session.mode,
          supervisorSessionId: session.id
        });
        return session;
      } catch (error) {
        if (error instanceof SupervisorActionError) {
          return reply.code(error.statusCode).send({ message: error.message });
        }
        throw error;
      }
    }
  );

  app.delete("/admin/supervisor-sessions/:sessionId", async (request, reply): Promise<void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) return;
    const params = supervisorSessionParamsSchema.parse(request.params);
    try {
      await stopSupervisorSession(pool, config, {
        actorUserId: user.id,
        sessionId: params.sessionId
      });
      await appendAdminAuditMetadata(pool, request.id, {
        action: "supervisor_stopped",
        supervisorSessionId: params.sessionId
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof SupervisorActionError) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      throw error;
    }
  });

  app.get("/admin/campaigns", async (request, reply): Promise<AdminCampaignListResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const query = adminLibraryQuerySchema.parse(request.query);
    return getCampaignsPage(pool, query, contactRetryPolicy);
  });

  app.get(
    "/admin/campaigns/:campaignId/recordings.zip",
    async (request, reply): Promise<FastifyReply | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }
      const params = campaignParamsSchema.parse(request.params);
      const exported = await openCampaignRecordingExport(
        pool,
        params.campaignId,
        config.CALL_RECORDINGS_STORAGE_DIR
      );
      if (exported.status === "campaign_not_found") {
        return reply.code(404).send({ message: "Campaign not found" });
      }
      if (exported.status === "no_recordings") {
        return reply.code(404).send({ message: "No playable call recordings found for this campaign" });
      }

      try {
        await recordCampaignRecordingExportAudit(pool, request, user.id, {
          campaignId: params.campaignId,
          includedCount: exported.includedCount,
          skippedCount: exported.skippedCount
        });
      } catch (error) {
        exported.abort();
        throw error;
      }
      const abortExport = () => exported.abort();
      request.raw.once("aborted", abortExport);
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) abortExport();
      });
      return reply
        .header("Content-Type", "application/zip")
        .header("Cache-Control", "private, no-store")
        .header("X-Recording-Count", exported.includedCount)
        .header("X-Recording-Skipped-Count", exported.skippedCount)
        .header("Content-Disposition", `attachment; filename="${exported.filename}"`)
        .send(exported.stream);
    }
  );

  app.get("/admin/recordings", async (request, reply): Promise<AdminRecordingListResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const query = adminLibraryQuerySchema.parse(request.query);
    return getRecordingsPage(pool, query);
  });

  app.get("/admin/users", async (request, reply): Promise<AdminUserListResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const query = adminLibraryQuerySchema.parse(request.query);
    return getUsersPage(pool, query);
  });

  app.get("/admin/calls", async (request, reply): Promise<CallHistoryResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const query = callHistoryQuerySchema.parse(request.query);
    return getCallHistoryPage(pool, query);
  });

  app.get("/admin/calls/export.csv", async (request, reply): Promise<void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const query = callHistoryQuerySchema.omit({ page: true, pageSize: true }).parse(request.query);
    const exportResult = await openCallHistoryCsvExport(pool, query, config.CALL_HISTORY_EXPORT_MAX_ROWS);
    if (!exportResult.stream) {
      reply.code(413).send({
        message: `Export contains ${exportResult.total} rows; narrow the filters below the configured ${config.CALL_HISTORY_EXPORT_MAX_ROWS}-row limit`
      });
      return;
    }
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="call-history-${new Date().toISOString().slice(0, 10)}.csv"`
      );
    reply.send(exportResult.stream);
  });

  app.get("/admin/calls/:callId", async (request, reply): Promise<CallDetailResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const detail = await getCallDetail(pool, params.callId);
    if (!detail) {
      return reply.code(404).send({ message: "Call not found" });
    }
    return detail;
  });

  app.put("/admin/calls/:callId/avmd-review", async (request, reply): Promise<CallAvmdReview | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) return;
    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const input = upsertCallAvmdReviewSchema.parse(request.body);
    const result = await upsertCallAvmdReview(pool, {
      callId: params.callId,
      actualParty: input.actualParty,
      notes: input.notes,
      reviewerUserId: user.id
    });
    if (result.status === "ok") return result.review;
    if (result.status === "not_found") {
      return reply.code(404).send({ message: "Call not found" });
    }
    return reply.code(409).send({ message: "Only completed calls with AVMD attempted can be reviewed" });
  });

  app.get("/admin/calls/:callId/recording", async (request, reply): Promise<void> => {
    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const user = await requireAdminOrMediaTicket(
      request,
      reply,
      config,
      pool,
      "call_recording",
      params.callId
    );
    if (!user) {
      return;
    }

    const recording = await getCallRecordingAudioFile(pool, params.callId);
    if (!recording) {
      return reply.code(404).send({ message: "Call recording not found" });
    }

    const fileStat = await stat(recording.filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      return reply.code(404).send({ message: "Call recording file not found" });
    }
    if (fileStat.size === 0) {
      return reply.code(409).send({ message: "Call recording file is empty" });
    }

    return sendAudioFile(request, reply, recording.filePath, `${params.callId}.wav`, fileStat.size);
  });

  app.post(
    "/admin/calls/:callId/recording-ticket",
    async (request, reply): Promise<MediaTicketResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }
      const params = z.object({ callId: z.string().uuid() }).parse(request.params);
      if (!(await getCallRecordingAudioFile(pool, params.callId))) {
        return reply.code(404).send({ message: "Call recording not found" });
      }
      return issueMediaTicket(
        pool,
        user.id,
        "call_recording",
        params.callId,
        `/admin/calls/${params.callId}/recording`,
        config.MEDIA_TICKET_TTL_SECONDS
      );
    }
  );

  app.get("/admin/calls/:callId/pcap", async (request, reply): Promise<FastifyReply | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const capture = await pool.query<{ file_path: string | null; file_size_bytes: string | number | null }>(
      `
        select file_path, file_size_bytes
        from call_pcaps
        where call_id = $1
          and status = 'available'
          and file_path is not null
      `,
      [params.callId]
    );
    const row = capture.rows[0];
    if (!row?.file_path || row.file_path !== callPcapPath(config.PCAP_STORAGE_DIR, params.callId)) {
      return reply.code(404).send({ message: "PCAP capture is not available" });
    }
    let fileSize = Number(row.file_size_bytes ?? 0);
    try {
      fileSize = (await stat(row.file_path)).size;
    } catch (error) {
      if (isMissingFileError(error)) {
        return reply.code(404).send({ message: "PCAP capture file is missing" });
      }
      throw error;
    }
    return sendDownloadFile(reply, row.file_path, `${params.callId}.pcap`, fileSize);
  });

  app.get(
    "/admin/freeswitch/diagnostics",
    async (request, reply): Promise<FreeSwitchDiagnosticsResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      return buildFreeSwitchDiagnostics(pool, config);
    }
  );

  app.post(
    "/admin/freeswitch/safe-test",
    async (request, reply): Promise<FreeSwitchSafeTestResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      return runFreeSwitchSafeTest(pool, config);
    }
  );

  app.post("/admin/retention/run", async (request, reply): Promise<RetentionRunResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const input = retentionRunSchema.parse(request.body ?? {});
    if (input.dryRun) {
      return runRetention(pool, {
        dryRun: true,
        callRetentionDays: config.CALL_LOG_RETENTION_DAYS,
        recordingRetentionDays: config.CALL_RECORDING_RETENTION_DAYS,
        pcapRetentionDays: config.PCAP_RETENTION_DAYS
      });
    }

    try {
      const result = await runRetentionWithAdvisoryLock(pool, {
        callRetentionDays: config.CALL_LOG_RETENTION_DAYS,
        recordingRetentionDays: config.CALL_RECORDING_RETENTION_DAYS,
        pcapRetentionDays: config.PCAP_RETENTION_DAYS
      });
      if (result.status === "locked") {
        return reply.code(409).send({ message: "A retention run is already in progress" });
      }
      recordRetentionSuccess(result.result);
      return result.result;
    } catch (error) {
      recordRetentionFailure();
      throw error;
    }
  });

  app.get("/admin/audit-events", async (request, reply): Promise<AdminAuditResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const query = adminAuditQuerySchema.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const result = await pool.query<{
      id: string;
      actor_name: string | null;
      actor_email: string | null;
      method: string;
      route: string;
      status_code: number;
      source_ip: string | null;
      metadata_json: Record<string, unknown>;
      created_at: Date;
      total_count: string;
    }>(
      `
        select
          admin_audit_events.id,
          users.name as actor_name,
          users.email as actor_email,
          admin_audit_events.method,
          admin_audit_events.route,
          admin_audit_events.status_code,
          admin_audit_events.source_ip,
          admin_audit_events.metadata_json,
          admin_audit_events.created_at,
          count(*) over() as total_count
        from admin_audit_events
        left join users on users.id = admin_audit_events.actor_user_id
        where ($1::uuid is null or admin_audit_events.actor_user_id = $1)
          and ($2::text is null or admin_audit_events.method = $2)
          and ($3::timestamptz is null or admin_audit_events.created_at >= $3)
          and ($4::timestamptz is null or admin_audit_events.created_at <= $4)
        order by admin_audit_events.created_at desc
        limit $5 offset $6
      `,
      [
        query.actorId ?? null,
        query.method ?? null,
        query.dateFrom ?? null,
        query.dateTo ?? null,
        query.pageSize,
        offset
      ]
    );
    return {
      page: query.page,
      pageSize: query.pageSize,
      total: Number(result.rows[0]?.total_count ?? 0),
      items: result.rows.map((row) => ({
        id: row.id,
        actorName: row.actor_name ?? "Deleted user",
        actorEmail: row.actor_email ?? "",
        method: row.method,
        route: row.route,
        statusCode: row.status_code,
        sourceIp: row.source_ip,
        metadata: row.metadata_json ?? {},
        createdAt: row.created_at.toISOString()
      }))
    };
  });

  app.get("/admin/csv-imports", async (request, reply): Promise<CsvImportHistoryResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const query = csvImportLibraryQuerySchema.parse(request.query);
    return getCsvImportsPage(pool, query);
  });

  app.get("/admin/csv-imports/:importId", async (request, reply): Promise<CsvImportDetailResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const params = z.object({ importId: z.string().uuid() }).parse(request.params);
    const query = csvImportFailuresQuerySchema.parse(request.query);
    const detail = await getCsvImportDetail(pool, params.importId, query);
    if (!detail) {
      return reply.code(404).send({ message: "CSV import not found" });
    }
    return detail;
  });

  app.get(
    "/admin/campaigns/:campaignId/contacts",
    async (request, reply): Promise<CampaignContactsResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const params = z.object({ campaignId: z.string().uuid() }).parse(request.params);
      const query = contactsQuerySchema.parse(request.query);
      return getCampaignContacts(pool, params.campaignId, query);
    }
  );

  app.post(
    "/agent/manual-dial/validate",
    async (request, reply): Promise<ManualDialValidationResponse | void> => {
      const user = await requireUser(request, config, pool);
      if (!user) {
        return reply.code(401).send({ message: "Unauthorized" });
      }

      const input = manualDialValidationSchema.parse(request.body);
      return validateDialableNumber(pool, config, input.phoneNumber, input.campaignId);
    }
  );

  app.post("/agent/manual-dial/start", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const publicUser = toPublicUser(user);
    const input = manualDialValidationSchema.parse(request.body);
    const validation = await validateDialableNumber(pool, config, input.phoneNumber, input.campaignId);
    if (!validation.allowed) {
      if (validation.reason.toLowerCase().includes("suppression")) {
        await auditBlockedManualDial(
          pool,
          user.id,
          input.phoneNumber,
          validation.normalizedNumber,
          validation.reason
        );
      }
      return reply.code(400).send({ message: validation.reason });
    }

    const campaign = await getAgentCampaignForDialerAction(pool, input.campaignId, contactRetryPolicy);
    if (!campaign) {
      return reply.code(409).send({ message: "No campaign is available" });
    }
    if (!campaign.manual_dialing_enabled) {
      return reply.code(409).send({ message: "Manual dialing is disabled for this campaign" });
    }

    const agent = await ensureAgentForUser(pool, config, publicUser);
    const created = await createDialerCall(pool, config, {
      actorUserId: publicUser.id,
      agentId: agent.id,
      campaignId: campaign.id,
      contactId: null,
      destinationNumber: validation.normalizedNumber,
      normalizedDestinationNumber: validation.normalizedNumber,
      sipUsername: agent.sipUsername,
      manualDial: true,
      callRecordingEnabled: campaign.call_recording_enabled,
      earlyMediaAvmdEnabled: campaign.early_media_avmd_enabled,
      eventType: "manual_dial_started"
    });
    if (!created.ok) {
      return reply.code(409).send({ message: createDialerCallFailureMessage(created.reason) });
    }

    return buildAgentDeskResponse(pool, publicUser, campaign.id, contactRetryPolicy);
  });

  app.post("/agent/call-next", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const input = startNextCallSchema.parse(request.body ?? {});
    const publicUser = toPublicUser(user);
    const campaign = await getAgentCampaignForDialerAction(pool, input.campaignId, contactRetryPolicy);
    if (!campaign) {
      return reply.code(409).send({ message: "No campaign is available" });
    }

    const agent = await ensureAgentForUser(pool, config, publicUser);
    const created = await createDialerCall(pool, config, {
      actorUserId: publicUser.id,
      agentId: agent.id,
      campaignId: campaign.id,
      contactId: "next",
      sipUsername: agent.sipUsername,
      manualDial: false,
      callRecordingEnabled: campaign.call_recording_enabled,
      earlyMediaAvmdEnabled: campaign.early_media_avmd_enabled,
      eventType: "call_next_started"
    });
    if (!created.ok) {
      return reply.code(409).send({ message: createDialerCallFailureMessage(created.reason) });
    }

    return buildAgentDeskResponse(pool, publicUser, campaign.id, contactRetryPolicy);
  });

  app.post("/agent/leads/:contactId/call", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const publicUser = toPublicUser(user);
    const params = z.object({ contactId: z.string().uuid() }).parse(request.params);
    const input = startLeadCallSchema.parse(request.body ?? {});
    const agent = await ensureAgentForUser(pool, config, publicUser);
    const created = await createDialerCall(pool, config, {
      actorUserId: publicUser.id,
      agentId: agent.id,
      campaignId: null,
      contactId: params.contactId,
      sipUsername: agent.sipUsername,
      manualDial: false,
      callRecordingEnabled: false,
      earlyMediaAvmdEnabled: false,
      confirmCompletedLead: input.confirmCompletedLead === true,
      confirmRetryWait: input.confirmRetryWait === true,
      eventType: "lead_call_started"
    });
    if (!created.ok) {
      return reply.code(409).send({ message: createDialerCallFailureMessage(created.reason) });
    }

    return buildAgentDeskResponse(pool, publicUser, created.campaignId, contactRetryPolicy);
  });

  app.post("/agent/calls/:callId/end", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const publicUser = toPublicUser(user);
    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const input = endCallSchema.parse(request.body ?? {});
    const ended = await endDialerCall(pool, config, publicUser.id, params.callId);
    if (!ended) {
      return reply.code(404).send({ message: "Active call not found" });
    }

    return buildAgentDeskResponse(pool, publicUser, input.campaignId, contactRetryPolicy);
  });

  app.put("/agent/calls/:callId/status", async (request, reply): Promise<ManualCallStatusResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const input = updateCallStatusSchema.parse(request.body);
    const result = await setManualCallStatus(pool, {
      callId: params.callId,
      outcome: input.outcome,
      userId: user.id
    });
    if (result.status === "missing") {
      return reply.code(404).send({ message: "Call not found" });
    }
    if (result.status === "active") {
      return reply.code(409).send({ message: "The call must end before its status can be set manually" });
    }
    if (result.status === "locked") {
      return reply.code(409).send({ message: "The manually set call status is locked" });
    }
    if ("response" in result) return result.response;
    throw new Error(`Unexpected manual call status result: ${result.status}`);
  });

  app.post(
    "/agent/calls/:callId/drop-voicemail",
    async (request, reply): Promise<AgentDeskResponse | void> => {
      const user = await requireUser(request, config, pool);
      if (!user) {
        return reply.code(401).send({ message: "Unauthorized" });
      }

      const publicUser = toPublicUser(user);
      const params = z.object({ callId: z.string().uuid() }).parse(request.params);
      const input = dropVoicemailSchema.parse(request.body ?? {});
      const dropped = await dropVoicemailForCall(
        pool,
        config,
        publicUser.id,
        params.callId,
        input.recordingId
      );
      if (!dropped.ok) {
        return reply.code(dropped.statusCode).send({ message: dropped.message });
      }

      return buildAgentDeskResponse(pool, publicUser, input.campaignId, contactRetryPolicy);
    }
  );

  app.post("/agent/calls/:callId/dtmf", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const publicUser = toPublicUser(user);
    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const input = sendDtmfSchema.parse(request.body ?? {});
    const sent = await sendDtmfForCall(pool, config, publicUser.id, params.callId, input.digit);
    if (!sent.ok) {
      return reply.code(sent.statusCode).send({ message: sent.message });
    }

    return buildAgentDeskResponse(pool, publicUser, input.campaignId, contactRetryPolicy);
  });

  app.post(
    "/admin/campaigns",
    async (request, reply): Promise<MutationResponse<AdminOverviewResponse["campaigns"][number]> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const input = createCampaignSchema.parse(request.body);
      const autoAdvanceToNextLeadEnabled = input.autoAdvanceToNextLeadEnabled ?? false;
      const result = await pool.query<{
        id: string;
        name: string;
        status: AdminOverviewResponse["campaigns"][number]["status"];
      }>(
        `
          insert into campaigns (
            name,
            status,
            manual_dialing_enabled,
            call_recording_enabled,
            early_media_avmd_enabled,
            auto_advance_to_next_lead_enabled
          )
          values ($1, $2, $3, $4, $5, $6)
          returning id, name, status
        `,
        [
          input.name,
          input.status,
          input.manualDialingEnabled,
          input.callRecordingEnabled,
          input.earlyMediaAvmdEnabled,
          autoAdvanceToNextLeadEnabled
        ]
      );

      const row = result.rows[0];
      return reply.code(201).send({
        item: {
          id: row.id,
          name: row.name,
          status: row.status,
          loaded: 0,
          callable: 0,
          manualDialingEnabled: input.manualDialingEnabled,
          callRecordingEnabled: input.callRecordingEnabled,
          earlyMediaAvmdEnabled: input.earlyMediaAvmdEnabled,
          autoAdvanceToNextLeadEnabled
        }
      });
    }
  );

  app.patch(
    "/admin/campaigns/:campaignId",
    async (request, reply): Promise<MutationResponse<AdminOverviewResponse["campaigns"][number]> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const params = campaignParamsSchema.parse(request.params);
      const input = updateCampaignSchema.parse(request.body);
      const result = await pool.query(
        `
          update campaigns
          set name = $2,
              status = $3,
              manual_dialing_enabled = $4,
              call_recording_enabled = $5,
              early_media_avmd_enabled = $6,
              auto_advance_to_next_lead_enabled = coalesce($7, auto_advance_to_next_lead_enabled),
              updated_at = now()
          where id = $1
        `,
        [
          params.campaignId,
          input.name,
          input.status,
          input.manualDialingEnabled,
          input.callRecordingEnabled,
          input.earlyMediaAvmdEnabled,
          input.autoAdvanceToNextLeadEnabled
        ]
      );

      if (!result.rowCount) {
        return reply.code(404).send({ message: "Campaign not found" });
      }

      const item = await getCampaignOverviewItem(pool, params.campaignId, contactRetryPolicy);
      if (!item) {
        return reply.code(404).send({ message: "Campaign not found" });
      }
      return { item };
    }
  );

  app.post(
    "/admin/campaigns/:campaignId/reset-leads",
    async (request, reply): Promise<ResetCampaignLeadsResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const params = campaignParamsSchema.parse(request.params);
      const result = await resetCampaignLeads(pool, params.campaignId);
      if (result === "not_found") {
        return reply.code(404).send({ message: "Campaign not found" });
      }
      if (result === "active_call") {
        return reply.code(409).send({ message: "Campaign has an active call" });
      }

      const item = await getCampaignOverviewItem(pool, params.campaignId, contactRetryPolicy);
      if (!item) {
        return reply.code(404).send({ message: "Campaign not found" });
      }
      return { item, resetCount: result.resetCount };
    }
  );

  app.delete("/admin/campaigns/:campaignId", async (request, reply): Promise<DeleteResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const params = campaignParamsSchema.parse(request.params);
    const deleted = await deleteCampaign(pool, params.campaignId);
    if (deleted === "not_found") {
      return reply.code(404).send({ message: "Campaign not found" });
    }
    if (deleted === "active_call") {
      return reply.code(409).send({ message: "Campaign has an active call" });
    }
    return { ok: true };
  });

  app.post("/admin/recordings", async (request, reply): Promise<CreateRecordingResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const file = await request.file({
      limits: { fileSize: config.VOICEMAIL_UPLOAD_MAX_BYTES, files: 1 }
    });
    if (!file) {
      return reply.code(400).send({ message: "Recording file is required" });
    }

    const extension = getSupportedRecordingExtension(file.filename);
    if (!extension) {
      return reply.code(400).send({ message: "Recording must be a WAV or MP3 file" });
    }

    const name = normalizeRecordingName(getMultipartFieldValue(file.fields.name), file.filename);
    const makeDefault = parseBooleanField(getMultipartFieldValue(file.fields.makeDefault));
    const fileId = randomUUID();
    const storedFilename = `${fileId}.wav`;
    const storagePath = join(config.VOICEMAIL_RECORDINGS_STORAGE_DIR, storedFilename);
    const sourcePath = join(config.VOICEMAIL_RECORDINGS_STORAGE_DIR, `${fileId}.upload${extension}`);
    await mkdir(config.VOICEMAIL_RECORDINGS_STORAGE_DIR, { recursive: true });

    try {
      await pipeline(file.file, createWriteStream(sourcePath, { flags: "wx", mode: 0o600 }));
      const uploaded = await stat(sourcePath);
      if (!uploaded.isFile() || uploaded.size === 0) {
        return reply.code(400).send({ message: "Recording file is empty" });
      }
      const processed = await transcodeRecordingToCanonicalWav(sourcePath, storagePath, {
        ffmpegPath: config.FFMPEG_PATH,
        ffprobePath: config.FFPROBE_PATH
      });
      const item = await createRecording(pool, {
        name,
        filePath: storagePath,
        runtimeFilePath: storagePath,
        durationSeconds: processed.durationSeconds,
        fileSizeBytes: processed.fileSizeBytes,
        makeDefault
      });
      return reply.code(201).send({ item });
    } catch (error) {
      await unlink(storagePath).catch(() => undefined);
      if (error instanceof RecordingProcessingError) {
        const status = error.code === "processor_unavailable" ? 503 : 400;
        return reply.code(status).send({ message: error.message });
      }
      throw error;
    } finally {
      await unlink(sourcePath).catch(() => undefined);
    }
  });

  app.patch(
    "/admin/recordings/:recordingId/default",
    async (request, reply): Promise<MutationResponse<AdminOverviewResponse["recordings"][number]> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const params = recordingParamsSchema.parse(request.params);
      const item = await setDefaultRecording(pool, params.recordingId);
      if (!item) {
        return reply.code(404).send({ message: "Recording not found" });
      }
      return { item };
    }
  );

  app.get("/admin/recordings/:recordingId/audio", async (request, reply): Promise<void> => {
    const params = recordingParamsSchema.parse(request.params);
    const user = await requireAdminOrMediaTicket(
      request,
      reply,
      config,
      pool,
      "voicemail_recording",
      params.recordingId
    );
    if (!user) {
      return;
    }

    const recording = await getRecordingAudioFile(pool, params.recordingId);
    if (!recording) {
      return reply.code(404).send({ message: "Recording not found" });
    }

    const fileStat = await stat(recording.filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      return reply.code(404).send({ message: "Recording file not found" });
    }
    if (fileStat.size === 0) {
      return reply
        .code(409)
        .send({ message: "Recording file is empty; delete it and upload the voicemail again" });
    }

    return sendAudioFile(request, reply, recording.filePath, recording.filename, fileStat.size);
  });

  app.post(
    "/admin/recordings/:recordingId/audio-ticket",
    async (request, reply): Promise<MediaTicketResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }
      const params = recordingParamsSchema.parse(request.params);
      if (!(await getRecordingAudioFile(pool, params.recordingId))) {
        return reply.code(404).send({ message: "Recording not found" });
      }
      return issueMediaTicket(
        pool,
        user.id,
        "voicemail_recording",
        params.recordingId,
        `/admin/recordings/${params.recordingId}/audio`,
        config.MEDIA_TICKET_TTL_SECONDS
      );
    }
  );

  app.delete("/admin/recordings/:recordingId", async (request, reply): Promise<DeleteResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const params = recordingParamsSchema.parse(request.params);
    const deleted = await deleteRecording(pool, params.recordingId);
    if (deleted.status === "not_found") {
      return reply.code(404).send({ message: "Recording not found" });
    }
    if (deleted.status === "in_use") {
      return reply.code(409).send({ message: "Recording is assigned to an active call or voicemail job" });
    }

    try {
      await unlink(deleted.filePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        await restoreDeletedRecording(pool, params.recordingId);
        request.log.error(
          { error, recordingId: params.recordingId },
          "Voicemail recording deletion failed; the database record was restored"
        );
        return reply.code(503).send({ message: "Recording file could not be deleted; try again" });
      }
    }
    return { ok: true };
  });

  app.post("/admin/contacts", async (request, reply): Promise<MutationResponse<LeadSummary> | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const input = createContactSchema.parse(request.body);
    if (!(await campaignExists(pool, input.campaignId))) {
      return reply.code(404).send({ message: "Campaign not found" });
    }

    const normalized = normalizePhoneNumber(input.phoneNumber, config.DEFAULT_PHONE_COUNTRY_CODE);
    if (!normalized.ok) {
      return reply.code(400).send({ message: normalized.reason });
    }
    const mappedFields = Object.fromEntries((input.fields ?? []).map((field) => [field.label, field.value]));
    if (input.company) {
      mappedFields.Company = input.company;
    }

    const result = await pool.query<{
      id: string;
      display_name: string | null;
      phone_number: string;
      mapped_fields_json: Record<string, unknown>;
    }>(
      `
          insert into contacts (
            campaign_id,
            phone_number,
            normalized_phone_number,
            display_name,
            mapped_fields_json,
            status
          )
          values ($1, $2, $3, $4, $5::jsonb, 'new')
          on conflict (campaign_id, normalized_phone_number) do nothing
          returning id, display_name, phone_number, mapped_fields_json
        `,
      [input.campaignId, input.phoneNumber, normalized.number, input.name, JSON.stringify(mappedFields)]
    );

    const row = result.rows[0];
    if (!row) {
      return reply.code(409).send({ message: "Lead already exists in this campaign" });
    }

    const suppression = await findSuppression(pool, normalized.number);
    return reply.code(201).send({
      item: {
        id: row.id,
        name: row.display_name ?? input.name,
        company: String(row.mapped_fields_json.Company ?? row.mapped_fields_json.company ?? ""),
        phoneNumber: row.phone_number,
        status: suppression ? "suppressed" : "ready",
        fields: Object.entries(row.mapped_fields_json ?? {}).map(([label, value]) => ({
          label,
          value: String(value)
        }))
      }
    });
  });

  app.post(
    "/admin/contacts/:contactId/suppress",
    async (request, reply): Promise<MutationResponse<CampaignContactListItem> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const params = z.object({ contactId: z.string().uuid() }).parse(request.params);
      const input = suppressContactSchema.parse(request.body ?? {});
      const contact = await pool.query<{
        phone_number: string;
        normalized_phone_number: string;
      }>(
        `
          select phone_number, normalized_phone_number
          from contacts
          where id = $1
        `,
        [params.contactId]
      );
      const row = contact.rows[0];
      if (!row) {
        return reply.code(404).send({ message: "Contact not found" });
      }

      await pool.query(
        `
          insert into suppression_entries (phone_number, normalized_phone_number, reason, created_by_user_id)
          values ($1, $2, $3, $4)
          on conflict (normalized_phone_number)
          do update set reason = excluded.reason
        `,
        [
          row.phone_number,
          row.normalized_phone_number,
          input.reason ?? "Suppressed from campaign contact list",
          user.id
        ]
      );

      const item = await getContactListItem(pool, params.contactId);
      if (!item) {
        return reply.code(404).send({ message: "Contact not found" });
      }
      return { item };
    }
  );

  app.post(
    "/admin/contacts/:contactId/complete",
    async (request, reply): Promise<MutationResponse<CampaignContactListItem> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const params = z.object({ contactId: z.string().uuid() }).parse(request.params);
      const result = await pool.query(
        `
          update contacts
          set status = 'completed',
              updated_at = now()
          where id = $1
        `,
        [params.contactId]
      );
      if (!result.rowCount) {
        return reply.code(404).send({ message: "Contact not found" });
      }

      const item = await getContactListItem(pool, params.contactId);
      if (!item) {
        return reply.code(404).send({ message: "Contact not found" });
      }
      return { item };
    }
  );

  app.post(
    "/admin/campaigns/:campaignId/import-csv",
    { bodyLimit: csvJsonBodyLimit },
    async (request, reply): Promise<ImportCsvResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const params = z.object({ campaignId: z.string().uuid() }).parse(request.params);
      const input = importCsvSchema.parse(request.body);
      if (!(await campaignExists(pool, params.campaignId))) {
        return reply.code(404).send({ message: "Campaign not found" });
      }

      try {
        const parsed = parseCsv(input.csvText, {
          maxBytes: config.CSV_UPLOAD_MAX_BYTES,
          maxRows: config.CSV_IMPORT_MAX_ROWS
        });
        if (parsed.rows.length === 0) {
          return reply.code(400).send({ message: "CSV has no data rows" });
        }
        const importResult = await importContactsFromCsv(
          pool,
          params.campaignId,
          input.filename,
          parsed,
          config.DEFAULT_PHONE_COUNTRY_CODE
        );
        return reply.code(201).send(importResult);
      } catch (error) {
        if (error instanceof CsvImportError) {
          return reply.code(400).send({ message: error.message });
        }
        if (isCsvImportCampaignForeignKeyError(error)) {
          return reply.code(404).send({ message: "Campaign not found" });
        }
        throw error;
      }
    }
  );

  app.post(
    "/admin/campaigns/:campaignId/import-csv-file",
    async (request, reply): Promise<ImportCsvResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const params = z.object({ campaignId: z.string().uuid() }).parse(request.params);
      let file;
      try {
        file = await request.file({ limits: { fileSize: config.CSV_UPLOAD_MAX_BYTES, files: 1 } });
      } catch (error) {
        if (isMultipartFileTooLarge(error)) {
          return reply
            .code(413)
            .send({ message: `CSV exceeds configured limit of ${config.CSV_UPLOAD_MAX_BYTES} bytes` });
        }
        throw error;
      }
      if (!file) {
        return reply.code(400).send({ message: "CSV file is required" });
      }
      if (!isCsvFilename(file.filename)) {
        return reply.code(400).send({ message: "Only .csv files are supported" });
      }
      try {
        const csvText = (await file.toBuffer()).toString("utf8");
        if (!(await campaignExists(pool, params.campaignId))) {
          return reply.code(404).send({ message: "Campaign not found" });
        }
        const parsed = parseCsv(csvText, {
          maxBytes: config.CSV_UPLOAD_MAX_BYTES,
          maxRows: config.CSV_IMPORT_MAX_ROWS
        });
        if (parsed.rows.length === 0) {
          return reply.code(400).send({ message: "CSV has no data rows" });
        }
        const importResult = await importContactsFromCsv(
          pool,
          params.campaignId,
          file.filename,
          parsed,
          config.DEFAULT_PHONE_COUNTRY_CODE
        );
        return reply.code(201).send(importResult);
      } catch (error) {
        if (isMultipartFileTooLarge(error)) {
          return reply
            .code(413)
            .send({ message: `CSV exceeds configured limit of ${config.CSV_UPLOAD_MAX_BYTES} bytes` });
        }
        if (error instanceof CsvImportError) {
          return reply.code(400).send({ message: error.message });
        }
        if (isCsvImportCampaignForeignKeyError(error)) {
          return reply.code(404).send({ message: "Campaign not found" });
        }
        throw error;
      }
    }
  );

  app.post(
    "/admin/suppression",
    async (
      request,
      reply
    ): Promise<MutationResponse<AdminOverviewResponse["suppression"][number]> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const input = createSuppressionSchema.parse(request.body);
      const normalized = normalizePhoneNumber(input.phoneNumber, config.DEFAULT_PHONE_COUNTRY_CODE);
      if (!normalized.ok) {
        return reply.code(400).send({ message: normalized.reason });
      }
      const client = await pool.connect();
      let row: { id: string; phone_number: string; reason: string | null; inserted: boolean };
      try {
        await client.query("begin");
        const result = await client.query<typeof row>(
          `
            insert into suppression_entries (phone_number, normalized_phone_number, reason, created_by_user_id)
            values ($1, $2, $3, $4)
            on conflict (normalized_phone_number)
            do update set phone_number = excluded.phone_number,
                          reason = excluded.reason,
                          created_by_user_id = excluded.created_by_user_id
            returning id, phone_number, reason, (xmax = 0) as inserted
          `,
          [input.phoneNumber, normalized.number, input.reason ?? null, user.id]
        );
        row = result.rows[0];
        await client.query(
          `
            insert into suppression_events (
              suppression_entry_id, actor_user_id, event_type, phone_number, normalized_phone_number, reason
            )
            values ($1, $2, $3, $4, $5, $6)
          `,
          [
            row.id,
            user.id,
            row.inserted ? "created" : "updated",
            row.phone_number,
            normalized.number,
            row.reason
          ]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      return reply.code(201).send({
        item: {
          id: row.id,
          phoneNumber: row.phone_number,
          reason: row.reason ?? "Suppressed",
          createdAt: new Date().toISOString()
        }
      });
    }
  );

  app.get("/admin/suppression", async (request, reply): Promise<SuppressionListResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }
    const query = suppressionQuerySchema.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const result = await pool.query<{
      id: string;
      phone_number: string;
      reason: string | null;
      created_at: Date;
      total_count: string;
    }>(
      `
        select id, phone_number, reason, created_at, count(*) over() as total_count
        from suppression_entries
        where ($1 = '' or concat_ws(' ', phone_number, normalized_phone_number, reason) ilike '%' || $1 || '%')
        order by created_at desc
        limit $2 offset $3
      `,
      [query.q.trim(), query.pageSize, offset]
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        phoneNumber: row.phone_number,
        reason: row.reason ?? "Suppressed",
        createdAt: row.created_at.toISOString()
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: total ? Math.ceil(total / query.pageSize) : 0
    };
  });

  app.post(
    "/admin/suppression/import-csv-file",
    async (request, reply): Promise<SuppressionImportResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }
      let file;
      try {
        file = await request.file({ limits: { fileSize: config.CSV_UPLOAD_MAX_BYTES, files: 1 } });
      } catch (error) {
        if (isMultipartFileTooLarge(error)) {
          return reply
            .code(413)
            .send({ message: `CSV exceeds configured limit of ${config.CSV_UPLOAD_MAX_BYTES} bytes` });
        }
        throw error;
      }
      if (!file) {
        return reply.code(400).send({ message: "CSV file is required" });
      }
      if (!isCsvFilename(file.filename)) {
        return reply.code(400).send({ message: "Only .csv files are supported" });
      }
      try {
        const parsed = parseCsv((await file.toBuffer()).toString("utf8"), {
          maxBytes: config.CSV_UPLOAD_MAX_BYTES,
          maxRows: config.CSV_IMPORT_MAX_ROWS
        });
        if (!parsed.rows.length) {
          return reply.code(400).send({ message: "CSV has no data rows" });
        }
        return reply.code(201).send(
          await importSuppressionFromCsv(pool, {
            actorUserId: user.id,
            filename: file.filename,
            parsed,
            defaultCountryCode: config.DEFAULT_PHONE_COUNTRY_CODE
          })
        );
      } catch (error) {
        if (isMultipartFileTooLarge(error)) {
          return reply
            .code(413)
            .send({ message: `CSV exceeds configured limit of ${config.CSV_UPLOAD_MAX_BYTES} bytes` });
        }
        if (error instanceof CsvImportError) {
          return reply.code(400).send({ message: error.message });
        }
        throw error;
      }
    }
  );

  app.delete("/admin/suppression/:suppressionId", async (request, reply): Promise<DeleteResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const params = suppressionParamsSchema.parse(request.params);
    const client = await pool.connect();
    let removed:
      | { id: string; phone_number: string; normalized_phone_number: string; reason: string | null }
      | undefined;
    try {
      await client.query("begin");
      const result = await client.query<{
        id: string;
        phone_number: string;
        normalized_phone_number: string;
        reason: string | null;
      }>(
        `
          delete from suppression_entries
          where id = $1
          returning id, phone_number, normalized_phone_number, reason
        `,
        [params.suppressionId]
      );
      removed = result.rows[0];
      if (removed) {
        await client.query(
          `
            insert into suppression_events (
              suppression_entry_id, actor_user_id, event_type, phone_number, normalized_phone_number, reason
            )
            values (null, $1, 'removed', $2, $3, $4)
          `,
          [user.id, removed.phone_number, removed.normalized_phone_number, removed.reason]
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    if (!removed) {
      return reply.code(404).send({ message: "Suppression entry not found" });
    }
    return { ok: true };
  });
}

async function recordCampaignRecordingExportAudit(
  pool: pg.Pool,
  request: FastifyRequest,
  actorUserId: string,
  details: { campaignId: string; includedCount: number; skippedCount: number }
): Promise<void> {
  await pool.query(
    `
      insert into admin_audit_events (
        actor_user_id,
        request_id,
        method,
        route,
        status_code,
        source_ip,
        user_agent,
        metadata_json
      )
      values ($1, $2, 'GET', '/admin/campaigns/:campaignId/recordings.zip', 200, $3, $4, $5::jsonb)
    `,
    [
      actorUserId,
      request.id,
      request.ip,
      request.headers["user-agent"] ?? null,
      JSON.stringify({ action: "campaign_recordings_export_started", ...details })
    ]
  );
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  pool: pg.Pool
): Promise<PublicUser | null> {
  const user = await requireUser(request, config, pool);
  if (!user) {
    reply.code(401).send({ message: "Unauthorized" });
    return null;
  }
  if (user.role !== "admin") {
    reply.code(403).send({ message: "Admin role required" });
    return null;
  }
  return toPublicUser(user);
}

async function appendAdminAuditMetadata(
  pool: pg.Pool,
  requestId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `update admin_audit_events
     set metadata_json = metadata_json || $2::jsonb
     where request_id = $1`,
    [requestId, JSON.stringify(metadata)]
  );
}

async function requireAdminOrMediaTicket(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  pool: pg.Pool,
  resourceType: MediaResourceType,
  resourceId: string
): Promise<PublicUser | { ticket: true } | null> {
  const headerUser = await requireUser(request, config, pool);
  if (headerUser) {
    if (headerUser.role !== "admin") {
      reply.code(403).send({ message: "Admin role required" });
      return null;
    }
    return toPublicUser(headerUser);
  }

  const query = recordingAudioQuerySchema.parse(request.query);
  if (
    !query.ticket ||
    !(await verifyMediaTicket(pool, {
      ticket: query.ticket,
      resourceType,
      resourceId,
      idleLifetimeSeconds: config.MEDIA_TICKET_TTL_SECONDS,
      absoluteLifetimeSeconds: config.MEDIA_TICKET_MAX_LIFETIME_SECONDS
    }))
  ) {
    reply.code(401).send({ message: "Unauthorized" });
    return null;
  }
  return { ticket: true };
}

async function issueMediaTicket(
  pool: pg.Pool,
  userId: string,
  resourceType: MediaResourceType,
  resourceId: string,
  path: string,
  lifetimeSeconds: number
): Promise<MediaTicketResponse> {
  const created = await createMediaTicket(pool, { userId, resourceType, resourceId, lifetimeSeconds });
  return {
    url: `${path}?${new URLSearchParams({ ticket: created.ticket }).toString()}`,
    expiresAt: created.expiresAt.toISOString()
  };
}

function sendAudioFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  filename: string,
  size: number
): FastifyReply {
  const rangeHeader = typeof request.headers.range === "string" ? request.headers.range : undefined;
  const range = parseSingleByteRange(rangeHeader, size);
  if (rangeHeader && !range) {
    return reply.code(416).header("Content-Range", `bytes */${size}`).send();
  }

  reply
    .header("Content-Type", getRecordingContentType(filePath))
    .header("Accept-Ranges", "bytes")
    .header("Cache-Control", "private, no-store")
    .header("Content-Disposition", `inline; filename="${filename.replace(/["\r\n]/g, "")}"`);
  if (range) {
    return reply
      .code(206)
      .header("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
      .header("Content-Length", range.end - range.start + 1)
      .send(createReadStream(filePath, range));
  }
  return reply.header("Content-Length", size).send(createReadStream(filePath));
}

function sendDownloadFile(
  reply: FastifyReply,
  filePath: string,
  filename: string,
  size: number
): FastifyReply {
  return reply
    .header("Content-Type", "application/vnd.tcpdump.pcap")
    .header("Content-Length", size)
    .header("Cache-Control", "private, no-store")
    .header("Content-Disposition", `attachment; filename="${filename.replace(/["\r\n]/g, "")}"`)
    .send(createReadStream(filePath));
}

function csvCell(value: string): string {
  const spreadsheetSafe = /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

async function* streamCallHistoryCsv(
  pool: pg.Pool,
  filters: Omit<CallHistoryFilters, "page" | "pageSize">,
  first: CallHistoryResponse,
  rowBudget: number
): AsyncGenerator<string> {
  yield callHistoryCsvRows([
    [
      "created_at",
      "lead",
      "phone",
      "campaign",
      "agent",
      "state",
      "outcome",
      "duration_seconds",
      "voicemail_signal",
      "recording_available"
    ]
  ]);

  const snapshot = getCallHistoryPageBounds(first).first;
  let current = first;
  let emittedRows = 0;
  while (current.items.length && emittedRows < rowBudget) {
    const items = current.items.slice(0, rowBudget - emittedRows);
    yield callHistoryCsvRows(
      items.map((item) => [
        item.createdAt,
        item.leadName,
        item.phoneNumber,
        item.campaignName,
        item.agentName,
        item.state,
        item.outcome ?? "",
        String(item.durationSeconds),
        item.voicemailSignal ?? "",
        String(item.recordingAvailable)
      ])
    );
    emittedRows += items.length;
    if (emittedRows >= rowBudget) break;
    if (current.items.length < first.pageSize) break;
    const cursor = getCallHistoryPageBounds(current).last;
    if (!cursor || !snapshot) break;
    current = await getCallHistoryPage(pool, {
      ...filters,
      page: 1,
      pageSize: first.pageSize,
      snapshot,
      cursor,
      includeTotal: false
    });
    // The count window on keyset pages describes the remaining rows, while
    // the initial count remains the export-size decision made at request time.
    if (!current.items.length) break;
  }
}

async function openCallHistoryCsvExport(
  pool: pg.Pool,
  filters: Omit<CallHistoryFilters, "page" | "pageSize">,
  maximumRows: number
): Promise<{ stream: Readable | null; total: number }> {
  const first = await getCallHistoryPage(pool, { ...filters, page: 1, pageSize: 1_000 });
  if (first.total > maximumRows) return { stream: null, total: first.total };
  return {
    stream: Readable.from(streamCallHistoryCsv(pool, filters, first, Math.min(first.total, maximumRows))),
    total: first.total
  };
}

function callHistoryCsvRows(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function auditBlockedManualDial(
  pool: pg.Pool,
  userId: string,
  phoneNumber: string,
  normalizedPhoneNumber: string,
  reason: string
): Promise<void> {
  await pool.query(
    `
      insert into suppression_events (
        suppression_entry_id, actor_user_id, event_type, phone_number, normalized_phone_number, reason
      )
      values (
        (select id from suppression_entries where normalized_phone_number = $2 limit 1),
        $1, 'blocked_manual_dial', $3, $2, $4
      )
    `,
    [userId, normalizedPhoneNumber, phoneNumber, reason]
  );
}

async function buildFreeSwitchDiagnostics(
  pool: pg.Pool,
  config: AppConfig
): Promise<FreeSwitchDiagnosticsResponse> {
  const checkedAt = new Date().toISOString();
  const lastSafeTest = await pool.query<{ updated_at: Date }>(
    "select updated_at from system_settings where key = 'freeswitch.safe_test.last'"
  );
  const esl = await checkEslHealth(config);
  const trunk = await checkTrunkStatus(config);

  return {
    checkedAt,
    esl,
    trunk,
    controlPlane: {
      safeTestAvailable: config.FREESWITCH_ESL_ENABLED,
      listenerEnabled: config.FREESWITCH_ESL_ENABLED,
      lastSafeTestAt: lastSafeTest.rows[0]?.updated_at.toISOString()
    }
  };
}

async function runFreeSwitchSafeTest(pool: pg.Pool, config: AppConfig): Promise<FreeSwitchSafeTestResponse> {
  const checkedAt = new Date().toISOString();
  let generatedUuid: string | undefined;
  let jobUuid: string | undefined;
  let uuidCreated = false;
  let apiStatusOk = false;
  let bgapiStatusQueued = false;
  let message = "FreeSWITCH control plane test passed";

  try {
    generatedUuid = await createFreeSwitchUuid(config);
    uuidCreated = Boolean(generatedUuid);
    await sendFreeSwitchApiCommand(config, "status");
    apiStatusOk = true;
    const bgapi = await sendFreeSwitchBgapiCommand(config, "status");
    jobUuid = parseBgapiJobUuid(bgapi.body);
    bgapiStatusQueued = Boolean(
      jobUuid || bgapi.body.includes("+OK") || bgapi.headers["reply-text"]?.includes("+OK")
    );
  } catch (error) {
    message = error instanceof Error ? error.message : "FreeSWITCH control plane test failed";
  }

  const result: FreeSwitchSafeTestResponse = {
    ok: uuidCreated && apiStatusOk && bgapiStatusQueued,
    checkedAt,
    uuidCreated,
    apiStatusOk,
    bgapiStatusQueued,
    generatedUuid,
    jobUuid,
    message
  };

  await pool.query(
    `
      insert into system_settings (key, value_json, updated_at)
      values ('freeswitch.safe_test.last', $1::jsonb, now())
      on conflict (key)
      do update set value_json = excluded.value_json,
                    updated_at = now()
    `,
    [JSON.stringify(result)]
  );

  return result;
}

async function checkEslHealth(config: AppConfig): Promise<FreeSwitchDiagnosticsResponse["esl"]> {
  if (!config.FREESWITCH_ESL_ENABLED) {
    return {
      status: "skipped",
      message: "Disabled by FREESWITCH_ESL_ENABLED=false"
    };
  }

  try {
    return {
      status: "ok",
      message: await checkFreeSwitchEsl(config)
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "FreeSWITCH ESL check failed"
    };
  }
}

async function checkTrunkStatus(config: AppConfig): Promise<FreeSwitchDiagnosticsResponse["trunk"]> {
  const base = {
    mode: config.SIP_TRUNK_MODE,
    configured: canOriginateCustomerLeg(config),
    gatewayName: config.SIP_TRUNK_MODE === "registration" ? "sip-trunk" : undefined,
    proxyConfigured: Boolean(config.SIP_TRUNK_PROXY),
    usernameConfigured: Boolean(config.SIP_TRUNK_USERNAME),
    callerIdConfigured: Boolean(config.SIP_TRUNK_CALLER_ID)
  };

  if (!base.configured) {
    return {
      ...base,
      status: "not_configured",
      summary:
        config.SIP_TRUNK_MODE === "ip_auth"
          ? "SIP_TRUNK_PROXY is required before outbound calls can be originated."
          : "SIP_TRUNK_PROXY and SIP_TRUNK_USERNAME are required before outbound calls can be originated."
    };
  }

  if (config.SIP_TRUNK_MODE === "ip_auth") {
    return {
      ...base,
      status: "ready",
      summary: "IP-auth trunk variables are present; provider registration is not expected in this mode."
    };
  }

  try {
    const gateway = await sendFreeSwitchApiCommand(config, "sofia status gateway sip-trunk");
    const status = parseGatewayStatus(gateway.body || gateway.raw);
    return {
      ...base,
      status,
      summary: summarizeGatewayStatus(status),
      raw: redactDiagnosticText(gateway.body || gateway.raw)
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      summary: error instanceof Error ? error.message : "Could not read SIP trunk gateway status"
    };
  }
}

function parseGatewayStatus(raw: string): FreeSwitchTrunkStatus {
  const normalized = raw.toLowerCase();
  if (normalized.includes("dns error")) {
    return "dns_error";
  }
  if (/\breged\b/.test(normalized) || (normalized.includes("state") && normalized.includes("reged"))) {
    return "ready";
  }
  if (normalized.includes("failed") || normalized.includes("fail_wait") || normalized.includes("unreged")) {
    return "registration_failed";
  }
  return "unknown";
}

function summarizeGatewayStatus(status: FreeSwitchTrunkStatus): string {
  if (status === "ready") {
    return "SIP trunk is configured and connected.";
  }
  if (status === "dns_error") {
    return "SIP trunk is unavailable due to DNS resolution error.";
  }
  if (status === "registration_failed") {
    return "SIP trunk is configured but failed to register.";
  }
  if (status === "error") {
    return "Could not read SIP trunk status.";
  }
  return "SIP trunk status is not conclusive yet.";
}

function parseBgapiJobUuid(body: string): string | undefined {
  return body.match(/Job-UUID:\s*([^\s]+)/i)?.[1];
}

function redactDiagnosticText(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/password|authorization|auth/i.test(line))
    .join("\n")
    .slice(0, 3000);
}

function isCsvImportCampaignForeignKeyError(error: unknown): error is { code: string; constraint: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23503" &&
    "constraint" in error &&
    error.constraint === "csv_imports_campaign_id_fkey"
  );
}

function isMultipartFileTooLarge(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "FST_REQ_FILE_TOO_LARGE" || error.code === "FST_FILES_LIMIT")
  );
}

async function getCsvImportDetail(
  pool: pg.Pool,
  importId: string,
  query: { failurePage: number; failurePageSize: number } = { failurePage: 1, failurePageSize: 50 }
): Promise<CsvImportDetailResponse | null> {
  const imports = await pool.query<{
    id: string;
    campaign_id: string;
    campaign_name: string | null;
    filename: string;
    status: string;
    total_rows: number;
    imported_rows: number;
    failed_rows: number;
    field_mapping_json: { duplicateRows?: number } | null;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `
      select
        csv_imports.id,
        csv_imports.campaign_id,
        campaigns.name as campaign_name,
        csv_imports.filename,
        csv_imports.status,
        csv_imports.total_rows,
        csv_imports.imported_rows,
        csv_imports.failed_rows,
        csv_imports.field_mapping_json,
        csv_imports.created_at,
        csv_imports.completed_at
      from csv_imports
      left join campaigns on campaigns.id = csv_imports.campaign_id
      where csv_imports.id = $1
    `,
    [importId]
  );

  const row = imports.rows[0];
  if (!row) {
    return null;
  }

  const failedRows = Number(row.failed_rows);
  return {
    import: {
      id: row.id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name ?? "Deleted campaign",
      filename: row.filename,
      status: row.status,
      totalRows: Number(row.total_rows),
      importedRows: Number(row.imported_rows),
      failedRows,
      duplicateRows: Number(row.field_mapping_json?.duplicateRows ?? 0),
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString()
    },
    failures: await getCsvImportFailures(pool, importId, query),
    failurePage: query.failurePage,
    failurePageSize: query.failurePageSize,
    failureTotalPages: failedRows ? Math.ceil(failedRows / query.failurePageSize) : 0
  };
}

async function getCsvImportFailures(
  pool: pg.Pool,
  importId: string,
  query: { failurePage: number; failurePageSize: number }
): Promise<CsvImportFailure[]> {
  const result = await pool.query<{
    id: string;
    row_number: number;
    reason: string;
    row_json: Record<string, string>;
  }>(
    `
      select id, row_number, reason, row_json
      from csv_import_failures
      where import_id = $1
      order by row_number asc
      limit $2 offset $3
    `,
    [importId, query.failurePageSize, (query.failurePage - 1) * query.failurePageSize]
  );

  return result.rows.map((row) => ({
    id: row.id,
    rowNumber: Number(row.row_number),
    reason: row.reason,
    row: row.row_json
  }));
}

async function getContactListItem(pool: pg.Pool, contactId: string): Promise<CampaignContactListItem | null> {
  const result = await pool.query<{
    id: string;
    display_name: string | null;
    phone_number: string;
    mapped_fields_json: Record<string, unknown>;
    company: string | null;
    contact_status: CampaignContactListItem["status"];
    created_at: Date;
  }>(
    `
      select
        contacts.id,
        contacts.display_name,
        contacts.phone_number,
        contacts.mapped_fields_json,
        contacts.created_at,
        coalesce(contacts.mapped_fields_json ->> 'Company', contacts.mapped_fields_json ->> 'company') as company,
        case
          when suppression_entries.id is not null then 'suppressed'
          when contacts.status in ('completed', 'suppressed') then contacts.status
          else 'ready'
        end as contact_status
      from contacts
      left join suppression_entries
        on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where contacts.id = $1
      limit 1
    `,
    [contactId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.display_name ?? "Unknown contact",
    company: row.company ?? "",
    phoneNumber: row.phone_number,
    status: row.contact_status,
    createdAt: row.created_at.toISOString(),
    fields: Object.entries(row.mapped_fields_json ?? {})
      .slice(0, 8)
      .map(([label, value]) => ({ label, value: String(value) }))
  };
}

async function getCampaignContacts(
  pool: pg.Pool,
  campaignId: string,
  query: {
    q: string;
    status: "all" | "ready" | "suppressed" | "completed";
    page: number;
    pageSize: number;
  }
): Promise<CampaignContactsResponse> {
  const search = query.q.trim();
  const offset = (query.page - 1) * query.pageSize;
  const result = await pool.query<{
    id: string;
    display_name: string | null;
    phone_number: string;
    mapped_fields_json: Record<string, unknown>;
    company: string | null;
    contact_status: "ready" | "suppressed" | "completed";
    created_at: Date;
    total_count: string;
  }>(
    `
      with contact_rows as (
        select
          contacts.id,
          contacts.display_name,
          contacts.phone_number,
          contacts.mapped_fields_json,
          contacts.created_at,
          coalesce(contacts.mapped_fields_json ->> 'Company', contacts.mapped_fields_json ->> 'company') as company,
          case
            when suppression_entries.id is not null then 'suppressed'
            when contacts.status in ('completed', 'suppressed') then contacts.status
            else 'ready'
          end as contact_status
        from contacts
        left join suppression_entries
          on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
        where contacts.campaign_id = $1
      ),
      filtered as (
        select *
        from contact_rows
        where ($2 = '' or concat_ws(' ', display_name, phone_number, company, mapped_fields_json::text) ilike '%' || $2 || '%')
          and ($3 = 'all' or contact_status = $3)
      )
      select *, count(*) over() as total_count
      from filtered
      order by created_at desc
      limit $4 offset $5
    `,
    [campaignId, search, query.status, query.pageSize, offset]
  );

  const total = Number(result.rows[0]?.total_count ?? 0);
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: total ? Math.ceil(total / query.pageSize) : 0,
    contacts: result.rows.map((row) => ({
      id: row.id,
      name: row.display_name ?? "Unknown contact",
      company: row.company ?? "",
      phoneNumber: row.phone_number,
      status: row.contact_status,
      createdAt: row.created_at.toISOString(),
      fields: Object.entries(row.mapped_fields_json ?? {})
        .slice(0, 8)
        .map(([label, value]) => ({ label, value: String(value) }))
    }))
  };
}

export const __testing = {
  buildAgentDeskResponse,
  callHistoryCsvRows,
  createDialerCall,
  csvCell,
  formatElapsed,
  getActiveCallActions,
  getCallDetail,
  getCallRecordingAudioFile,
  getCampaignContacts,
  getCsvImportDetail,
  getAgentCampaign,
  getAgentCampaignForDialerAction,
  inferAgentEndOutcome,
  mapCallStatus,
  mapVoicemailSignal,
  normalizePhoneNumber,
  openCallHistoryCsvExport,
  parseCsv,
  sendAudioFile,
  sendDownloadFile,
  syncFreeSwitchOriginate,
  validateDialableNumber
};
