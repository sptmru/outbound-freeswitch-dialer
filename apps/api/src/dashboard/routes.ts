import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";
import type pg from "pg";
import { callOutcomes } from "@outbound-dialer/shared";
import type {
  AdminOverviewResponse,
  AgentDeskResponse,
  CallOutcome,
  CallState,
  CampaignContactListItem,
  CampaignContactsResponse,
  CreateCampaignRequest,
  CreateContactRequest,
  CreateRecordingResponse,
  CreateSuppressionRequest,
  CsvImportDetailResponse,
  CsvImportFailure,
  CsvImportHistoryResponse,
  DeleteResponse,
  DropVoicemailRequest,
  EndCallRequest,
  FreeSwitchDiagnosticsResponse,
  FreeSwitchSafeTestResponse,
  FreeSwitchTrunkStatus,
  ImportCsvRequest,
  ImportCsvResponse,
  LeadSummary,
  ManualDialValidationResponse,
  MutationResponse,
  PublicUser,
  SoftphoneProvisioningResponse,
  StartNextCallRequest,
  StartManualCallRequest,
  SuppressContactRequest,
  UpdateCampaignRequest
} from "@outbound-dialer/shared";
import { z } from "zod";
import { requireUser } from "../auth/routes.js";
import { verifyAuthToken } from "../auth/tokens.js";
import type { AppConfig } from "../config.js";
import {
  canOriginateCustomerLeg,
  checkFreeSwitchEsl,
  createFreeSwitchUuid,
  originateAgentBridgeCall,
  sendFreeSwitchApiCommand,
  sendFreeSwitchBgapiCommand
} from "../esl.js";
import { ensureAgentForUser, findUserById, getSoftphoneProvisioningForUser, toPublicUser } from "../users.js";

const manualDialValidationSchema = z.object({
  phoneNumber: z.string().min(3),
  campaignId: z.string().uuid().optional()
}) satisfies z.ZodType<StartManualCallRequest>;

const startNextCallSchema = z.object({
  campaignId: z.string().uuid().optional()
}) satisfies z.ZodType<StartNextCallRequest>;

const endCallSchema = z.object({
  outcome: z.enum(callOutcomes).optional(),
  campaignId: z.string().uuid().optional()
}) satisfies z.ZodType<EndCallRequest>;

const dropVoicemailSchema = z.object({
  campaignId: z.string().uuid().optional()
}) satisfies z.ZodType<DropVoicemailRequest>;

const createCampaignSchema = z.object({
  name: z.string().min(1).max(160),
  status: z.enum(["active", "paused", "draft"]),
  manualDialingEnabled: z.boolean(),
  callRecordingEnabled: z.boolean()
}) satisfies z.ZodType<CreateCampaignRequest>;

const updateCampaignSchema = z.object({
  name: z.string().min(1).max(160),
  status: z.enum(["active", "paused", "draft"])
}) satisfies z.ZodType<UpdateCampaignRequest>;

const createContactSchema = z.object({
  campaignId: z.string().uuid(),
  name: z.string().min(1).max(160),
  phoneNumber: z.string().min(3).max(64),
  company: z.string().max(160).optional(),
  fields: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().max(400) })).max(20).optional()
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
  csvText: z.string().min(1).max(2_000_000)
}) satisfies z.ZodType<ImportCsvRequest>;

const contactsQuerySchema = z.object({
  q: z.string().default(""),
  status: z.enum(["all", "ready", "suppressed", "completed"]).default("all")
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
  token: z.string().optional()
});

const agentDeskQuerySchema = z.object({
  campaignId: z.string().uuid().optional()
});

export function registerDashboardRoutes(app: FastifyInstance, config: AppConfig, pool: pg.Pool): void {
  app.get("/agent/desk", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const query = agentDeskQuerySchema.parse(request.query);
    return buildAgentDeskResponse(pool, toPublicUser(user), query.campaignId);
  });

  app.get("/agent/softphone/provisioning", async (request, reply): Promise<SoftphoneProvisioningResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    return getSoftphoneProvisioningForUser(pool, config, toPublicUser(user));
  });

  app.get("/admin/overview", async (request, reply): Promise<AdminOverviewResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }
    if (user.role !== "admin") {
      return reply.code(403).send({ message: "Admin role required" });
    }

    return buildAdminOverviewResponse(pool, toPublicUser(user));
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

  app.post("/admin/freeswitch/safe-test", async (request, reply): Promise<FreeSwitchSafeTestResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    return runFreeSwitchSafeTest(pool, config);
  });

  app.get("/admin/csv-imports", async (request, reply): Promise<CsvImportHistoryResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    return {
      imports: await getCsvImports(pool)
    };
  });

  app.get("/admin/csv-imports/:importId", async (request, reply): Promise<CsvImportDetailResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const params = z.object({ importId: z.string().uuid() }).parse(request.params);
    const detail = await getCsvImportDetail(pool, params.importId);
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

  app.post("/agent/manual-dial/validate", async (request, reply): Promise<ManualDialValidationResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const input = manualDialValidationSchema.parse(request.body);
    return validateDialableNumber(pool, config, input.phoneNumber);
  });

  app.post("/agent/manual-dial/start", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const publicUser = toPublicUser(user);
    const input = manualDialValidationSchema.parse(request.body);
    const validation = await validateDialableNumber(pool, config, input.phoneNumber);
    if (!validation.allowed) {
      return reply.code(400).send({ message: validation.reason });
    }

    const campaign = await getAgentCampaign(pool, input.campaignId);
    if (!campaign) {
      return reply.code(409).send({ message: "No campaign is available" });
    }
    if (!campaign.manual_dialing_enabled) {
      return reply.code(409).send({ message: "Manual dialing is disabled for this campaign" });
    }

    const activeCall = await getActiveCall(pool, publicUser.id);
    if (activeCall) {
      return reply.code(409).send({ message: "An active call is already in progress" });
    }

    const agent = await ensureAgentForUser(pool, config, publicUser);
    await createDialerCall(pool, config, {
      agentId: agent.id,
      campaignId: campaign.id,
      contactId: null,
      destinationNumber: validation.normalizedNumber,
      normalizedDestinationNumber: validation.normalizedNumber,
      sipUsername: agent.sipUsername,
      manualDial: true,
      callRecordingEnabled: campaign.call_recording_enabled,
      eventType: "manual_dial_started"
    });

    return buildAgentDeskResponse(pool, publicUser, campaign.id);
  });

  app.post("/agent/call-next", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const input = startNextCallSchema.parse(request.body ?? {});
    const publicUser = toPublicUser(user);
    const activeCall = await getActiveCall(pool, publicUser.id);
    if (activeCall) {
      return reply.code(409).send({ message: "An active call is already in progress" });
    }

    const campaign = await getAgentCampaign(pool, input.campaignId);
    if (!campaign) {
      return reply.code(409).send({ message: "No campaign is available" });
    }

    const agent = await ensureAgentForUser(pool, config, publicUser);
    const contact = await getNextCallableContact(pool, campaign.id);
    if (!contact) {
      return reply.code(409).send({ message: "No callable contacts are available" });
    }

    await createDialerCall(pool, config, {
      agentId: agent.id,
      campaignId: campaign.id,
      contactId: contact.id,
      destinationNumber: contact.phoneNumber,
      normalizedDestinationNumber: contact.normalizedPhoneNumber,
      sipUsername: agent.sipUsername,
      manualDial: false,
      callRecordingEnabled: campaign.call_recording_enabled,
      eventType: "call_next_started"
    });

    return buildAgentDeskResponse(pool, publicUser, campaign.id);
  });

  app.post("/agent/leads/:contactId/call", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const publicUser = toPublicUser(user);
    const activeCall = await getActiveCall(pool, publicUser.id);
    if (activeCall) {
      return reply.code(409).send({ message: "An active call is already in progress" });
    }

    const params = z.object({ contactId: z.string().uuid() }).parse(request.params);
    const contact = await getCallableContact(pool, params.contactId);
    if (!contact) {
      return reply.code(409).send({ message: "Lead is not callable" });
    }

    const agent = await ensureAgentForUser(pool, config, publicUser);
    await createDialerCall(pool, config, {
      agentId: agent.id,
      campaignId: contact.campaignId,
      contactId: contact.id,
      destinationNumber: contact.phoneNumber,
      normalizedDestinationNumber: contact.normalizedPhoneNumber,
      sipUsername: agent.sipUsername,
      manualDial: false,
      callRecordingEnabled: contact.callRecordingEnabled,
      eventType: "lead_call_started"
    });

    return buildAgentDeskResponse(pool, publicUser, contact.campaignId);
  });

  app.post("/agent/calls/:callId/end", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const publicUser = toPublicUser(user);
    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const input = endCallSchema.parse(request.body ?? {});
    const ended = await endDialerCall(pool, config, publicUser.id, params.callId, input.outcome ?? "agent_canceled");
    if (!ended) {
      return reply.code(404).send({ message: "Active call not found" });
    }

    return buildAgentDeskResponse(pool, publicUser, input.campaignId);
  });

  app.post("/agent/calls/:callId/drop-voicemail", async (request, reply): Promise<AgentDeskResponse | void> => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    const publicUser = toPublicUser(user);
    const params = z.object({ callId: z.string().uuid() }).parse(request.params);
    const input = dropVoicemailSchema.parse(request.body ?? {});
    const dropped = await dropVoicemailForCall(pool, config, publicUser.id, params.callId);
    if (!dropped.ok) {
      return reply.code(dropped.statusCode).send({ message: dropped.message });
    }

    return buildAgentDeskResponse(pool, publicUser, input.campaignId);
  });

  app.post(
    "/admin/campaigns",
    async (request, reply): Promise<MutationResponse<AdminOverviewResponse["campaigns"][number]> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const input = createCampaignSchema.parse(request.body);
  const result = await pool.query<{
    id: string;
    name: string;
    status: AdminOverviewResponse["campaigns"][number]["status"];
  }>(
        `
          insert into campaigns (name, status, manual_dialing_enabled, call_recording_enabled)
          values ($1, $2, $3, $4)
          returning id, name, status
        `,
        [input.name, input.status, input.manualDialingEnabled, input.callRecordingEnabled]
      );

      const row = result.rows[0];
      return reply.code(201).send({
        item: {
          id: row.id,
          name: row.name,
          status: row.status,
          loaded: 0,
          callable: 0
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
          set name = $2, status = $3, updated_at = now()
          where id = $1
        `,
        [params.campaignId, input.name, input.status]
      );

      if (!result.rowCount) {
        return reply.code(404).send({ message: "Campaign not found" });
      }

      const item = await getCampaignOverviewItem(pool, params.campaignId);
      if (!item) {
        return reply.code(404).send({ message: "Campaign not found" });
      }
      return { item };
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

  app.post(
    "/admin/recordings",
    async (request, reply): Promise<CreateRecordingResponse | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ message: "Recording file is required" });
      }

      const extension = getSupportedRecordingExtension(file.filename);
      if (!extension) {
        return reply.code(400).send({ message: "Recording must be a WAV or MP3 file" });
      }

      const name = normalizeRecordingName(getMultipartFieldValue(file.fields.name), file.filename);
      const makeDefault = parseBooleanField(getMultipartFieldValue(file.fields.makeDefault));
      const storedFilename = `${randomUUID()}${extension}`;
      const storagePath = join(config.VOICEMAIL_RECORDINGS_STORAGE_DIR, storedFilename);
      const audioBuffer = await file.toBuffer();
      if (audioBuffer.length === 0) {
        return reply.code(400).send({ message: "Recording file is empty" });
      }
      const durationSeconds = detectAudioDurationSeconds(audioBuffer, extension);

      await mkdir(config.VOICEMAIL_RECORDINGS_STORAGE_DIR, { recursive: true });
      await writeFile(storagePath, audioBuffer, { flag: "wx" });

      try {
        const item = await createRecording(pool, {
          name,
          filePath: storagePath,
          runtimeFilePath: storagePath,
          durationSeconds,
          fileSizeBytes: audioBuffer.length,
          makeDefault
        });
        return reply.code(201).send({ item });
      } catch (error) {
        await unlink(storagePath).catch(() => undefined);
        throw error;
      }
    }
  );

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
    const user = await requireAdminWithOptionalQueryToken(request, reply, config, pool);
    if (!user) {
      return;
    }

    const params = recordingParamsSchema.parse(request.params);
    const recording = await getRecordingAudioFile(pool, params.recordingId);
    if (!recording) {
      return reply.code(404).send({ message: "Recording not found" });
    }

    const fileStat = await stat(recording.filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      return reply.code(404).send({ message: "Recording file not found" });
    }
    if (fileStat.size === 0) {
      return reply.code(409).send({ message: "Recording file is empty; delete it and upload the voicemail again" });
    }

    reply
      .header("Content-Type", getRecordingContentType(recording.filePath))
      .header("Content-Length", fileStat.size)
      .header("Content-Disposition", `inline; filename="${recording.filename}"`)
      .send(await readFile(recording.filePath));
  });

  app.delete("/admin/recordings/:recordingId", async (request, reply): Promise<DeleteResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const params = recordingParamsSchema.parse(request.params);
    const deleted = await deleteRecording(pool, params.recordingId);
    if (!deleted) {
      return reply.code(404).send({ message: "Recording not found" });
    }

    await unlink(deleted.filePath).catch(() => undefined);
    return { ok: true };
  });

  app.post(
    "/admin/contacts",
    async (request, reply): Promise<MutationResponse<LeadSummary> | void> => {
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
          company: String(row.mapped_fields_json.Company ?? row.mapped_fields_json.company ?? "Unmapped company"),
          phoneNumber: row.phone_number,
          status: suppression ? "suppressed" : "ready",
          fields: Object.entries(row.mapped_fields_json ?? {}).map(([label, value]) => ({
            label,
            value: String(value)
          }))
        }
      });
    }
  );

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
        [row.phone_number, row.normalized_phone_number, input.reason ?? "Suppressed from campaign contact list", user.id]
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
        const parsed = parseCsv(input.csvText);
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
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ message: "CSV file is required" });
      }
      if (!isCsvFilename(file.filename)) {
        return reply.code(400).send({ message: "Only .csv files are supported" });
      }
      if (!(await campaignExists(pool, params.campaignId))) {
        return reply.code(404).send({ message: "Campaign not found" });
      }

      try {
        const csvText = (await file.toBuffer()).toString("utf8");
        const parsed = parseCsv(csvText);
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
    async (request, reply): Promise<MutationResponse<AdminOverviewResponse["suppression"][number]> | void> => {
      const user = await requireAdmin(request, reply, config, pool);
      if (!user) {
        return;
      }

      const input = createSuppressionSchema.parse(request.body);
      const normalized = normalizePhoneNumber(input.phoneNumber, config.DEFAULT_PHONE_COUNTRY_CODE);
      if (!normalized.ok) {
        return reply.code(400).send({ message: normalized.reason });
      }
      const result = await pool.query<{
        id: string;
        phone_number: string;
        reason: string | null;
      }>(
        `
          insert into suppression_entries (phone_number, normalized_phone_number, reason, created_by_user_id)
          values ($1, $2, $3, $4)
          on conflict (normalized_phone_number)
          do update set reason = excluded.reason
          returning id, phone_number, reason
        `,
        [input.phoneNumber, normalized.number, input.reason ?? null, user.id]
      );

      const row = result.rows[0];
      return reply.code(201).send({
        item: {
          id: row.id,
          phoneNumber: row.phone_number,
          reason: row.reason ?? "Suppressed"
        }
      });
    }
  );

  app.delete("/admin/suppression/:suppressionId", async (request, reply): Promise<DeleteResponse | void> => {
    const user = await requireAdmin(request, reply, config, pool);
    if (!user) {
      return;
    }

    const params = suppressionParamsSchema.parse(request.params);
    const result = await pool.query("delete from suppression_entries where id = $1", [params.suppressionId]);
    if (!result.rowCount) {
      return reply.code(404).send({ message: "Suppression entry not found" });
    }
    return { ok: true };
  });
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

async function requireAdminWithOptionalQueryToken(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  pool: pg.Pool
): Promise<PublicUser | null> {
  const headerUser = await requireUser(request, config, pool);
  if (headerUser) {
    if (headerUser.role !== "admin") {
      reply.code(403).send({ message: "Admin role required" });
      return null;
    }
    return toPublicUser(headerUser);
  }

  const query = recordingAudioQuerySchema.parse(request.query);
  const payload = query.token ? verifyAuthToken(config, query.token) : null;
  if (!payload) {
    reply.code(401).send({ message: "Unauthorized" });
    return null;
  }

  const user = await findUserById(pool, payload.sub);
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
    bgapiStatusQueued = Boolean(jobUuid || bgapi.body.includes("+OK") || bgapi.headers["reply-text"]?.includes("+OK"));
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
  if (/\breged\b/.test(normalized) || normalized.includes("state") && normalized.includes("reged")) {
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

async function findSuppression(pool: pg.Pool, normalizedNumber: string): Promise<{ reason: string | null } | null> {
  const result = await pool.query<{ reason: string | null }>(
    "select reason from suppression_entries where normalized_phone_number = $1",
    [normalizedNumber]
  );
  return result.rows[0] ?? null;
}

async function deleteCampaign(pool: pg.Pool, campaignId: string): Promise<"deleted" | "not_found" | "active_call"> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const campaign = await client.query("select id from campaigns where id = $1 for update", [campaignId]);
    if (!campaign.rowCount) {
      await client.query("rollback");
      return "not_found";
    }

    const activeCalls = await client.query(
      `
        select 1
        from calls
        where campaign_id = $1
          and ended_at is null
          and state not in ('completed', 'failed', 'canceled')
        limit 1
      `,
      [campaignId]
    );
    if (activeCalls.rowCount) {
      await client.query("rollback");
      return "active_call";
    }

    await client.query("update calls set contact_id = null where contact_id in (select id from contacts where campaign_id = $1)", [
      campaignId
    ]);
    await client.query("update calls set campaign_id = null where campaign_id = $1", [campaignId]);
    await client.query("delete from campaigns where id = $1", [campaignId]);
    await client.query("commit");
    return "deleted";
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function campaignExists(pool: pg.Pool, campaignId: string): Promise<boolean> {
  const result = await pool.query("select 1 from campaigns where id = $1", [campaignId]);
  return Boolean(result.rowCount);
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

async function validateDialableNumber(
  pool: pg.Pool,
  config: AppConfig,
  phoneNumber: string
): Promise<ManualDialValidationResponse> {
  const normalized = normalizePhoneNumber(phoneNumber, config.DEFAULT_PHONE_COUNTRY_CODE);
  const suppression = normalized.ok ? await findSuppression(pool, normalized.number) : null;
  const allowed = normalized.ok && !suppression;
  const normalizedFailureReason = normalized.ok ? "" : normalized.reason;

  return {
    normalizedNumber: normalized.ok ? normalized.number : "",
    allowed,
    reason: allowed
      ? "Number is callable"
      : suppression
        ? suppression.reason ?? "Number is suppressed"
        : normalizedFailureReason,
    checks: [
      {
        label: "Phone number",
        status: normalized.ok ? "pass" : "fail",
        detail: normalized.ok ? `Normalized to ${normalized.number}` : normalizedFailureReason
      },
      {
        label: "Suppression list",
        status: suppression ? "fail" : "pass",
        detail: suppression ? (suppression.reason ?? "Number is suppressed") : "No matching suppression entry"
      },
      {
        label: "Manual dialing",
        status: "pass",
        detail: "Allowed for this campaign"
      }
    ]
  };
}

async function getNextCallableContact(
  pool: pg.Pool,
  campaignId: string
): Promise<{ id: string; phoneNumber: string; normalizedPhoneNumber: string } | null> {
  const result = await pool.query<{
    id: string;
    phone_number: string;
    normalized_phone_number: string;
  }>(
    `
      select contacts.id, contacts.phone_number, contacts.normalized_phone_number
      from contacts
      left join suppression_entries
        on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where contacts.campaign_id = $1
        and contacts.status not in ('calling', 'completed', 'suppressed')
        and suppression_entries.id is null
      order by contacts.created_at asc
      limit 1
    `,
    [campaignId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    phoneNumber: row.phone_number,
    normalizedPhoneNumber: row.normalized_phone_number
  };
}

async function getCallableContact(
  pool: pg.Pool,
  contactId: string
): Promise<{
  id: string;
  campaignId: string;
  phoneNumber: string;
  normalizedPhoneNumber: string;
  callRecordingEnabled: boolean;
} | null> {
  const result = await pool.query<{
    id: string;
    campaign_id: string;
    phone_number: string;
    normalized_phone_number: string;
    call_recording_enabled: boolean;
  }>(
    `
      select
        contacts.id,
        contacts.campaign_id,
        contacts.phone_number,
        contacts.normalized_phone_number,
        campaigns.call_recording_enabled
      from contacts
      join campaigns on campaigns.id = contacts.campaign_id
      left join suppression_entries
        on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where contacts.id = $1
        and contacts.status not in ('calling', 'completed', 'suppressed')
        and suppression_entries.id is null
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
    campaignId: row.campaign_id,
    phoneNumber: row.phone_number,
    normalizedPhoneNumber: row.normalized_phone_number,
    callRecordingEnabled: row.call_recording_enabled
  };
}

async function getDefaultRecordingId(client: pg.Pool | pg.PoolClient): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `
      select id
      from recordings
      where is_active = true
      order by is_default desc, created_at desc
      limit 1
    `
  );
  return result.rows[0]?.id ?? null;
}

async function createDialerCall(
  pool: pg.Pool,
  config: AppConfig,
  input: {
    agentId: string;
    campaignId: string;
    contactId: string | null;
    destinationNumber: string;
    normalizedDestinationNumber: string;
    sipUsername: string;
    manualDial: boolean;
    callRecordingEnabled: boolean;
    eventType: string;
  }
): Promise<string> {
  const client = await pool.connect();
  let callId: string;
  try {
    await client.query("begin");
    const recordingId = await getDefaultRecordingId(client);
    const call = await client.query<{ id: string }>(
      `
        insert into calls (
          agent_id,
          campaign_id,
          contact_id,
          destination_number,
          normalized_destination_number,
          state,
          recording_id,
          manual_dial,
          call_recording_enabled,
          started_at
        )
        values ($1, $2, $3, $4, $5, 'customer_dialing', $6, $7, $8, now())
        returning id
      `,
      [
        input.agentId,
        input.campaignId,
        input.contactId,
        input.destinationNumber,
        input.normalizedDestinationNumber,
        recordingId,
        input.manualDial,
        input.callRecordingEnabled
      ]
    );
    callId = call.rows[0].id;

    await client.query(
      `
        insert into call_legs (call_id, type, state, started_at, sip_uri)
        values
          ($1, 'agent', 'created', now(), $2),
          ($1, 'customer', 'created', now(), null)
      `,
      [callId, `sip:${input.sipUsername}@${config.FREESWITCH_DOMAIN}`]
    );
    await client.query(
      `
        insert into call_events (call_id, agent_id, event_type, state, raw_json)
        values ($1, $2, $3, 'customer_dialing', $4::jsonb)
      `,
      [
        callId,
        input.agentId,
        input.eventType,
        JSON.stringify({
          destinationNumber: input.destinationNumber,
          manualDial: input.manualDial
        })
      ]
    );
    await client.query("update agents set status = 'in_call', updated_at = now() where id = $1", [input.agentId]);
    if (input.contactId) {
      await client.query("update contacts set status = 'calling', updated_at = now() where id = $1", [input.contactId]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  await syncFreeSwitchOriginate(pool, config, {
    agentId: input.agentId,
    callId,
    destinationNumber: input.destinationNumber,
    sipUsername: input.sipUsername
  });
  return callId;
}

async function syncFreeSwitchOriginate(
  pool: pg.Pool,
  config: AppConfig,
  input: { agentId: string; callId: string; destinationNumber: string; sipUsername: string }
): Promise<void> {
  if (!canOriginateCustomerLeg(config)) {
    await insertCallEvent(pool, {
      agentId: input.agentId,
      callId: input.callId,
      eventType: "freeswitch_originate_skipped",
      state: "customer_dialing",
      raw: {
        reason: "SIP trunk is not configured",
        destinationNumber: input.destinationNumber
      }
    });
    return;
  }

  try {
    const agentLegUuid = await createFreeSwitchUuid(config);
    const customerLegUuid = await createFreeSwitchUuid(config);
    const originate = await originateAgentBridgeCall(config, {
      agentLegUuid,
      callId: input.callId,
      customerLegUuid,
      destinationNumber: input.destinationNumber,
      sipUsername: input.sipUsername
    });
    await pool.query(
      `
        update call_legs
        set freeswitch_uuid = $2,
            state = 'started',
            started_at = coalesce(started_at, now())
        where call_id = $1
          and type = 'agent'
      `,
      [input.callId, originate.agentLegUuid]
    );
    await pool.query(
      `
        update call_legs
        set freeswitch_uuid = $2
        where call_id = $1
          and type = 'customer'
      `,
      [input.callId, originate.customerLegUuid]
    );
    await insertCallEvent(pool, {
      agentId: input.agentId,
      callId: input.callId,
      eventType: "freeswitch_agent_bridge_originate_queued",
      state: "agent_ringing",
      apiCommandName: "bgapi originate",
      agentLegUuid: originate.agentLegUuid,
      customerLegUuid: originate.customerLegUuid,
      raw: {
        command: originate.command,
        jobUuid: originate.jobUuid
      }
    });
    await pool.query(
      `
        update calls
        set state = 'agent_ringing',
            updated_at = now()
        where id = $1
          and state not in ('completed', 'failed', 'canceled')
      `,
      [input.callId]
    );
    scheduleOriginateWatchdog(pool, config, {
      agentId: input.agentId,
      callId: input.callId,
      customerLegUuid: originate.customerLegUuid,
      jobUuid: originate.jobUuid
    });
  } catch (error) {
    await pool.query(
      `
        update calls
        set state = 'failed',
            outcome = 'failed',
            ended_at = now(),
            updated_at = now()
        where id = $1
      `,
      [input.callId]
    );
    await pool.query(
      `
        update agents
        set status = 'ready',
            updated_at = now()
        where id = $1
      `,
      [input.agentId]
    );
    await pool.query(
      `
        update contacts
        set status = 'new',
            updated_at = now()
        where id = (
          select contact_id
          from calls
          where id = $1
        )
          and status = 'calling'
      `,
      [input.callId]
    );
    await insertCallEvent(pool, {
      agentId: input.agentId,
      callId: input.callId,
      eventType: "freeswitch_originate_failed",
      state: "failed",
      apiCommandName: "bgapi originate",
      raw: {
        message: error instanceof Error ? error.message : "FreeSWITCH originate failed"
      }
    });
  }
}

function scheduleOriginateWatchdog(
  pool: pg.Pool,
  config: AppConfig,
  input: { agentId: string; callId: string; customerLegUuid: string; jobUuid: string }
): void {
  const timer = setTimeout(() => {
    void closeMissingOriginateLeg(pool, config, input);
  }, 3000);
  timer.unref?.();
}

async function closeMissingOriginateLeg(
  pool: pg.Pool,
  config: AppConfig,
  input: { agentId: string; callId: string; customerLegUuid: string; jobUuid: string }
): Promise<void> {
  try {
    const response = await sendFreeSwitchApiCommand(config, `uuid_exists ${input.customerLegUuid}`);
    if (response.body.trim().toLowerCase().startsWith("true")) {
      return;
    }
    await failDialerCallFromFreeSwitch(pool, input.agentId, input.callId, input.customerLegUuid, {
      eventType: "freeswitch_originate_leg_missing",
      apiCommandName: "uuid_exists",
      raw: {
        customerLegUuid: input.customerLegUuid,
        jobUuid: input.jobUuid,
        response: response.body.trim() || response.headers["reply-text"] || ""
      }
    });
  } catch (error) {
    await insertCallEvent(pool, {
      agentId: input.agentId,
      callId: input.callId,
      eventType: "freeswitch_originate_watchdog_failed",
      state: "customer_dialing",
      apiCommandName: "uuid_exists",
      customerLegUuid: input.customerLegUuid,
      raw: {
        customerLegUuid: input.customerLegUuid,
        jobUuid: input.jobUuid,
        message: error instanceof Error ? error.message : "FreeSWITCH originate watchdog failed"
      }
    });
  }
}

async function failDialerCallFromFreeSwitch(
  pool: pg.Pool,
  agentId: string,
  callId: string,
  customerLegUuid: string,
  event: { eventType: string; apiCommandName: string; raw: Record<string, unknown> }
): Promise<void> {
  const updated = await pool.query(
    `
      update calls
      set state = 'failed',
          outcome = 'failed',
          ended_at = coalesce(ended_at, now()),
          updated_at = now()
      where id = $1
        and ended_at is null
        and state not in ('completed', 'failed', 'canceled')
      returning contact_id
    `,
    [callId]
  );
  if (!updated.rowCount) {
    return;
  }

  await pool.query(
    `
      update call_legs
      set state = 'ended',
          ended_at = coalesce(ended_at, now())
      where call_id = $1
        and type = 'customer'
    `,
    [callId]
  );
  await pool.query(
    `
      update agents
      set status = 'ready',
          updated_at = now()
      where id = $1
    `,
    [agentId]
  );
  await pool.query(
    `
      update contacts
      set status = 'new',
          updated_at = now()
      where id = $1
        and status = 'calling'
    `,
    [updated.rows[0]?.contact_id]
  );
  await insertCallEvent(pool, {
    agentId,
    callId,
    eventType: event.eventType,
    state: "failed",
    apiCommandName: event.apiCommandName,
    customerLegUuid,
    raw: event.raw
  });
}

async function killFreeSwitchLeg(
  pool: pg.Pool,
  config: AppConfig,
  callId: string,
  agentId: string,
  leg: { type: "agent" | "customer"; uuid: string | null }
): Promise<void> {
  if (!leg.uuid || !config.FREESWITCH_ESL_ENABLED) {
    return;
  }

  try {
    await sendFreeSwitchApiCommand(config, `uuid_kill ${leg.uuid}`);
    await insertCallEvent(pool, {
      agentId,
      callId,
      eventType: "freeswitch_uuid_kill_sent",
      state: "completed",
      apiCommandName: "uuid_kill",
      agentLegUuid: leg.type === "agent" ? leg.uuid : undefined,
      customerLegUuid: leg.type === "customer" ? leg.uuid : undefined,
      raw: { legType: leg.type, legUuid: leg.uuid }
    });
  } catch (error) {
    await insertCallEvent(pool, {
      agentId,
      callId,
      eventType: "freeswitch_uuid_kill_failed",
      state: "completed",
      apiCommandName: "uuid_kill",
      agentLegUuid: leg.type === "agent" ? leg.uuid : undefined,
      customerLegUuid: leg.type === "customer" ? leg.uuid : undefined,
      raw: {
        legType: leg.type,
        legUuid: leg.uuid,
        message: error instanceof Error ? error.message : "FreeSWITCH uuid_kill failed"
      }
    });
  }
}

async function insertCallEvent(
  pool: pg.Pool,
  input: {
    agentId: string;
    callId: string;
    eventType: string;
    state: string;
    apiCommandName?: string;
    agentLegUuid?: string;
    customerLegUuid?: string;
    raw: Record<string, unknown>;
  }
): Promise<void> {
  await pool.query(
    `
      insert into call_events (
        call_id,
        agent_id,
        event_type,
        state,
        api_command_name,
        agent_leg_uuid,
        customer_leg_uuid,
        raw_json
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    `,
    [
      input.callId,
      input.agentId,
      input.eventType,
      input.state,
      input.apiCommandName ?? null,
      input.agentLegUuid ?? null,
      input.customerLegUuid ?? null,
      JSON.stringify(input.raw)
    ]
  );
}

async function dropVoicemailForCall(
  pool: pg.Pool,
  config: AppConfig,
  userId: string,
  callId: string
): Promise<{ ok: true } | { ok: false; statusCode: 404 | 409 | 502; message: string }> {
  const result = await pool.query<{
    agent_id: string;
    contact_id: string | null;
    agent_leg_uuid: string | null;
    customer_leg_uuid: string | null;
    runtime_file_path: string | null;
  }>(
    `
      select
        calls.agent_id,
        calls.contact_id,
        agent_leg.freeswitch_uuid as agent_leg_uuid,
        customer_leg.freeswitch_uuid as customer_leg_uuid,
        recordings.runtime_file_path
      from calls
      join agents on agents.id = calls.agent_id
      left join call_legs agent_leg on agent_leg.call_id = calls.id and agent_leg.type = 'agent'
      left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
      left join recordings on recordings.id = calls.recording_id and recordings.is_active = true
      where calls.id = $1
        and agents.user_id = $2
        and calls.ended_at is null
        and calls.state not in ('completed', 'failed', 'canceled')
      limit 1
    `,
    [callId, userId]
  );
  const row = result.rows[0];
  if (!row) {
    return { ok: false, statusCode: 404, message: "Active call not found" };
  }
  if (!row.customer_leg_uuid) {
    return { ok: false, statusCode: 409, message: "Customer leg is not ready for voicemail drop" };
  }
  if (!row.runtime_file_path) {
    return { ok: false, statusCode: 409, message: "No voicemail recording is assigned to this call" };
  }

  try {
    const customerLegUuid = assertFreeSwitchApiArgument(row.customer_leg_uuid, "customer leg UUID");
    const voicemailPath = assertFreeSwitchApiArgument(row.runtime_file_path, "voicemail recording path");
    await sendFreeSwitchApiCommand(config, `uuid_setvar ${customerLegUuid} voicemail_drop_file ${voicemailPath}`);
    await sendFreeSwitchApiCommand(config, `uuid_transfer ${customerLegUuid} voicemail_drop XML default`);
  } catch (error) {
    await insertCallEvent(pool, {
      agentId: row.agent_id,
      callId,
      eventType: "voicemail_drop_failed",
      state: "bridged",
      apiCommandName: "uuid_transfer",
      agentLegUuid: row.agent_leg_uuid ?? undefined,
      customerLegUuid: row.customer_leg_uuid,
      raw: {
        message: error instanceof Error ? error.message : "FreeSWITCH voicemail drop failed",
        recordingPath: row.runtime_file_path
      }
    });
    return { ok: false, statusCode: 502, message: "FreeSWITCH could not start voicemail playback" };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const updated = await client.query(
      `
        update calls
        set state = 'completed',
            outcome = 'voicemail_dropped',
            ended_at = now(),
            updated_at = now()
        where id = $1
          and ended_at is null
          and state not in ('completed', 'failed', 'canceled')
      `,
      [callId]
    );
    if (!updated.rowCount) {
      await client.query("rollback");
      return { ok: false, statusCode: 404, message: "Active call not found" };
    }
    await client.query(
      `
        insert into call_events (call_id, agent_id, event_type, state, api_command_name, agent_leg_uuid, customer_leg_uuid, raw_json)
        values
          ($1, $2, 'voicemail_drop_requested', 'voicemail_drop_requested', 'uuid_setvar', $3, $4, $5::jsonb),
          ($1, $2, 'voicemail_playback_started', 'voicemail_playback_started', 'uuid_transfer', $3, $4, $5::jsonb),
          ($1, $2, 'agent_released', 'agent_released', null, $3, $4, $5::jsonb)
      `,
      [
        callId,
        row.agent_id,
        row.agent_leg_uuid,
        row.customer_leg_uuid,
        JSON.stringify({ recordingPath: row.runtime_file_path })
      ]
    );
    await client.query(
      `
        update call_legs
        set state = 'ended',
            ended_at = coalesce(ended_at, now())
        where call_id = $1
      `,
      [callId]
    );
    await client.query(
      `
        update agents
        set status = 'ready',
            updated_at = now()
        where id = $1
      `,
      [row.agent_id]
    );
    if (row.contact_id) {
      await client.query(
        `
          update contacts
          set status = 'completed',
              updated_at = now()
          where id = $1
            and status = 'calling'
        `,
        [row.contact_id]
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  if (row.agent_leg_uuid) {
    await killFreeSwitchLeg(pool, config, callId, row.agent_id, { type: "agent", uuid: row.agent_leg_uuid });
  }
  return { ok: true };
}

function assertFreeSwitchApiArgument(value: string, label: string): string {
  if (/\s/.test(value)) {
    throw new Error(`${label} contains whitespace and cannot be used in a FreeSWITCH API command`);
  }
  return value;
}

async function endDialerCall(
  pool: pg.Pool,
  config: AppConfig,
  userId: string,
  callId: string,
  outcome: CallOutcome
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const call = await client.query<{
      id: string;
      agent_id: string;
      contact_id: string | null;
      agent_leg_uuid: string | null;
      customer_leg_uuid: string | null;
    }>(
      `
        select
          calls.id,
          calls.agent_id,
          calls.contact_id,
          agent_leg.freeswitch_uuid as agent_leg_uuid,
          customer_leg.freeswitch_uuid as customer_leg_uuid
        from calls
        join agents on agents.id = calls.agent_id
        left join call_legs agent_leg on agent_leg.call_id = calls.id and agent_leg.type = 'agent'
        left join call_legs customer_leg on customer_leg.call_id = calls.id and customer_leg.type = 'customer'
        where calls.id = $1
          and agents.user_id = $2
          and calls.ended_at is null
          and calls.state not in ('completed', 'failed', 'canceled')
        for update of calls
      `,
      [callId, userId]
    );

    const row = call.rows[0];
    if (!row) {
      await client.query("rollback");
      return false;
    }

    await client.query(
      `
        update calls
        set state = 'completed',
            outcome = $2,
            ended_at = now(),
            updated_at = now()
        where id = $1
      `,
      [callId, outcome]
    );
    await client.query(
      `
        insert into call_events (call_id, agent_id, event_type, state, raw_json)
        values ($1, $2, 'call_ended', 'completed', $3::jsonb)
      `,
      [callId, row.agent_id, JSON.stringify({ outcome })]
    );

    if (row.contact_id) {
      const nextStatus = outcome === "agent_canceled" ? "new" : "completed";
      await client.query(
        `
          update contacts
          set status = $2,
              updated_at = now()
          where id = $1
            and status = 'calling'
        `,
        [row.contact_id, nextStatus]
      );
    }

    await client.query(
      `
        update agents
        set status = 'ready',
            updated_at = now()
        where id = $1
          and not exists (
            select 1
            from calls
            where calls.agent_id = agents.id
              and calls.ended_at is null
              and calls.state not in ('completed', 'failed', 'canceled')
          )
      `,
      [row.agent_id]
    );
    await client.query("commit");
    await killFreeSwitchLeg(pool, config, callId, row.agent_id, { type: "agent", uuid: row.agent_leg_uuid });
    await killFreeSwitchLeg(pool, config, callId, row.agent_id, { type: "customer", uuid: row.customer_leg_uuid });
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

class CsvImportError extends Error {}

async function importContactsFromCsv(
  pool: pg.Pool,
  campaignId: string,
  filename: string,
  parsed: ParsedCsv,
  defaultCountryCode?: string
): Promise<ImportCsvResponse> {
  const phoneIndex = findColumn(parsed.headers, ["phone", "phone_number", "number", "mobile", "cell"]);
  if (phoneIndex === -1) {
    throw new CsvImportError("CSV must include a phone column");
  }

  const nameIndex = findColumn(parsed.headers, ["name", "full_name", "contact", "display_name"]);
  const companyIndex = findColumn(parsed.headers, ["company", "business", "organization", "org"]);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const importInsert = await client.query<{ id: string }>(
      `
        insert into csv_imports (campaign_id, filename, status, field_mapping_json, total_rows)
        values ($1, $2, 'processing', $3::jsonb, $4)
        returning id
      `,
      [
        campaignId,
        filename,
        JSON.stringify({
          phone: parsed.headers[phoneIndex],
          name: nameIndex >= 0 ? parsed.headers[nameIndex] : null,
          company: companyIndex >= 0 ? parsed.headers[companyIndex] : null
        }),
        parsed.rows.length
      ]
    );

    const importId = importInsert.rows[0].id;
    let importedRows = 0;
    let failedRows = 0;
    let duplicateRows = 0;

    for (const [rowIndex, row] of parsed.rows.entries()) {
      const rowNumber = rowIndex + 2;
      const phoneNumber = (row[phoneIndex] ?? "").trim();
      const normalized = normalizePhoneNumber(phoneNumber, defaultCountryCode);
      const mappedFields = Object.fromEntries(
        parsed.headers.map((header, index) => [header, (row[index] ?? "").trim()])
      );

      if (!normalized.ok) {
        await insertCsvImportFailure(client, importId, rowNumber, normalized.reason, mappedFields);
        failedRows += 1;
        continue;
      }

      const displayName =
        nameIndex >= 0 && row[nameIndex]?.trim()
          ? row[nameIndex].trim()
          : companyIndex >= 0 && row[companyIndex]?.trim()
            ? row[companyIndex].trim()
            : phoneNumber;

      const insertResult = await client.query(
        `
          insert into contacts (
            campaign_id,
            phone_number,
            normalized_phone_number,
            display_name,
            source_row_json,
            mapped_fields_json,
            status
          )
          values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'new')
          on conflict (campaign_id, normalized_phone_number) do nothing
          returning id
        `,
        [
          campaignId,
          phoneNumber,
          normalized.number,
          displayName,
          JSON.stringify(mappedFields),
          JSON.stringify(mappedFields)
        ]
      );

      if (insertResult.rowCount) {
        importedRows += 1;
      } else {
        await insertCsvImportFailure(client, importId, rowNumber, "Duplicate phone number in this campaign", mappedFields);
        duplicateRows += 1;
        failedRows += 1;
      }
    }

    await client.query(
      `
        update csv_imports
        set status = 'completed',
            imported_rows = $2,
            failed_rows = $3,
            field_mapping_json = field_mapping_json || $4::jsonb,
            completed_at = now()
        where id = $1
      `,
      [importId, importedRows, failedRows, JSON.stringify({ duplicateRows })]
    );
    await client.query("commit");

    return {
      importId,
      filename,
      totalRows: parsed.rows.length,
      importedRows,
      failedRows,
      duplicateRows,
      detectedColumns: parsed.headers
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function insertCsvImportFailure(
  client: pg.PoolClient,
  importId: string,
  rowNumber: number,
  reason: string,
  row: Record<string, string>
): Promise<void> {
  await client.query(
    `
      insert into csv_import_failures (import_id, row_number, reason, row_json)
      values ($1, $2, $3, $4::jsonb)
    `,
    [importId, rowNumber, reason, JSON.stringify(row)]
  );
}

function parseCsv(input: string): ParsedCsv {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(field.trim());
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      field = "";
      row = [];
      continue;
    }

    field += char;
  }

  row.push(field.trim());
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }

  const headers = (rows.shift() ?? []).map((header) => header.trim()).filter(Boolean);
  if (!headers.length) {
    throw new CsvImportError("CSV header row is required");
  }

  return {
    headers,
    rows: rows.filter((csvRow) => csvRow.some((value) => value.trim().length > 0))
  };
}

function findColumn(headers: string[], candidates: string[]): number {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => candidates.includes(header));
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isCsvFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".csv");
}

async function buildAgentDeskResponse(
  pool: pg.Pool,
  user: PublicUser,
  selectedCampaignId?: string
): Promise<AgentDeskResponse> {
  const [campaign, availableCampaigns] = await Promise.all([
    getAgentCampaign(pool, selectedCampaignId),
    getAgentCampaigns(pool)
  ]);
  if (!campaign) {
    return buildDemoAgentDeskResponse(user);
  }

  const [leads, activeCall, metrics] = await Promise.all([
    getLeadQueue(pool, campaign.id),
    getActiveCall(pool, user.id),
    getAgentMetrics(pool, user.id)
  ]);

  return {
    user,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      callableLeads: Number(campaign.callable_leads),
      manualDialingEnabled: campaign.manual_dialing_enabled,
      callRecordingEnabled: campaign.call_recording_enabled
    },
    availableCampaigns,
    softphone: {
      registered: Boolean(campaign.agent_registered),
      microphoneAllowed: true,
      status: activeCall ? "in_call" : "ready"
    },
    metrics,
    leads: leads.length > 0 ? leads : buildDemoLeads(),
    activeCall
  };
}

async function buildAdminOverviewResponse(pool: pg.Pool, user: PublicUser): Promise<AdminOverviewResponse> {
  const [stats, campaigns, recordings, users, callHistory, suppression] = await Promise.all([
    getAdminStats(pool),
    getCampaigns(pool),
    getRecordings(pool),
    getUsers(pool),
    getCallHistory(pool),
    getSuppression(pool)
  ]);

  return {
    user,
    stats,
    campaigns,
    recordings,
    users,
    callHistory,
    suppression
  };
}

async function getAgentCampaign(
  pool: pg.Pool,
  selectedCampaignId?: string
): Promise<{
  id: string;
  name: string;
  status: "active" | "paused" | "draft";
  manual_dialing_enabled: boolean;
  call_recording_enabled: boolean;
  callable_leads: string;
  agent_registered: boolean;
} | null> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: "active" | "paused" | "draft";
    manual_dialing_enabled: boolean;
    call_recording_enabled: boolean;
    callable_leads: string;
    agent_registered: boolean;
  }>(`
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      campaigns.manual_dialing_enabled,
      campaigns.call_recording_enabled,
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
      ) as callable_leads,
      exists (
        select 1
        from agents
        where agents.status = 'registered'
      ) as agent_registered
    from campaigns
    left join contacts on contacts.campaign_id = campaigns.id
    left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    where campaigns.status = 'active'
    group by campaigns.id
    order by
      case when campaigns.id = $1 then 0 else 1 end,
      campaigns.created_at desc
    limit 1
  `, [selectedCampaignId ?? null]);

  return result.rows[0] ?? null;
}

async function getAgentCampaigns(pool: pg.Pool): Promise<AgentDeskResponse["availableCampaigns"]> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: "active" | "paused" | "draft";
    callable: string;
  }>(`
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
      ) as callable
    from campaigns
    left join contacts on contacts.campaign_id = campaigns.id
    left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    where campaigns.status = 'active'
    group by campaigns.id
    order by campaigns.created_at desc
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    callableLeads: Number(row.callable)
  }));
}

async function getLeadQueue(pool: pg.Pool, campaignId: string): Promise<LeadSummary[]> {
  const result = await pool.query<{
    id: string;
    display_name: string | null;
    phone_number: string;
    company: string | null;
    status: LeadSummary["status"];
    mapped_fields_json: Record<string, unknown>;
  }>(
    `
      select
        contacts.id,
        contacts.display_name,
        contacts.phone_number,
        contacts.mapped_fields_json,
        coalesce(contacts.mapped_fields_json ->> 'Company', contacts.mapped_fields_json ->> 'company') as company,
        case
          when suppression_entries.id is not null then 'suppressed'
          when contacts.status = 'calling' then 'calling'
          when contacts.status in ('completed', 'suppressed') then contacts.status
          else 'ready'
        end as status
      from contacts
      left join suppression_entries
        on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where contacts.campaign_id = $1
      order by contacts.created_at asc
      limit 25
    `,
    [campaignId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.display_name ?? "Unknown contact",
    company: row.company ?? "Unmapped company",
    phoneNumber: row.phone_number,
    status: row.status,
    fields: Object.entries(row.mapped_fields_json ?? {})
      .slice(0, 8)
      .map(([label, value]) => ({ label, value: String(value) }))
  }));
}

async function getActiveCall(pool: pg.Pool, userId: string): Promise<AgentDeskResponse["activeCall"]> {
  const result = await pool.query<{
    id: string;
    state: CallState;
    destination_number: string;
    contact_name: string | null;
    started_at: Date | null;
    answered_at: Date | null;
    voicemail_signal_status: string | null;
    recording_name: string | null;
  }>(
    `
      select
        calls.id,
        calls.state,
        calls.destination_number,
        contacts.display_name as contact_name,
        calls.started_at,
        calls.answered_at,
        calls.voicemail_signal_status,
        recordings.name as recording_name
      from calls
      join agents on agents.id = calls.agent_id
      left join contacts on contacts.id = calls.contact_id
      left join recordings on recordings.id = calls.recording_id
      where agents.user_id = $1
        and calls.ended_at is null
        and calls.state not in ('completed', 'failed', 'canceled')
      order by calls.created_at desc
      limit 1
    `,
    [userId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const startedAt = row.answered_at ?? row.started_at;
  const durationSeconds = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)) : 0;

  return {
    id: row.id,
    state: row.state,
    leadName: row.contact_name ?? "Manual dial",
    phoneNumber: row.destination_number,
    durationSeconds,
    status: mapCallStatus(row.state),
    voicemailSignal: mapVoicemailSignal(row.voicemail_signal_status),
    recordingName: row.recording_name ?? "No default recording",
    timeline: await getCallTimeline(pool, row.id)
  };
}

async function getCallTimeline(pool: pg.Pool, callId: string): Promise<Array<{ at: string; label: string }>> {
  const result = await pool.query<{
    event_type: string;
    created_at: Date;
  }>(
    `
      select event_type, created_at
      from call_events
      where call_id = $1
      order by created_at asc
      limit 12
    `,
    [callId]
  );

  if (!result.rows.length) {
    return [{ at: "now", label: "Call created" }];
  }

  const first = result.rows[0]?.created_at.getTime() ?? Date.now();
  return result.rows.map((row) => ({
    at: formatElapsed(Math.floor((row.created_at.getTime() - first) / 1000)),
    label: humanize(row.event_type)
  }));
}

async function getAgentMetrics(pool: pg.Pool, userId: string): Promise<AgentDeskResponse["metrics"]> {
  const result = await pool.query<{
    today_calls: string;
    voicemails_dropped: string;
    suppressed: string;
  }>(
    `
      select
        count(calls.id) filter (where calls.created_at >= date_trunc('day', now())) as today_calls,
        count(calls.id) filter (where calls.outcome = 'voicemail_dropped') as voicemails_dropped,
        (select count(*) from suppression_entries) as suppressed
      from agents
      left join calls on calls.agent_id = agents.id
      where agents.user_id = $1
    `,
    [userId]
  );
  const row = result.rows[0];

  return {
    todayCalls: Number(row?.today_calls ?? 0),
    voicemailsDropped: Number(row?.voicemails_dropped ?? 0),
    suppressed: Number(row?.suppressed ?? 0)
  };
}

async function getAdminStats(pool: pg.Pool): Promise<AdminOverviewResponse["stats"]> {
  const result = await pool.query<{
    campaigns: string;
    active_agents: string;
    calls_today: string;
    suppression_entries: string;
    live_calls: string;
  }>(`
    select
      (select count(*) from campaigns) as campaigns,
      (select count(*) from agents where status in ('ready', 'registered', 'in_call')) as active_agents,
      (select count(*) from calls where created_at >= date_trunc('day', now())) as calls_today,
      (select count(*) from suppression_entries) as suppression_entries,
      (select count(*) from calls where ended_at is null and state not in ('completed', 'failed', 'canceled')) as live_calls
  `);
  const row = result.rows[0];

  return {
    campaigns: Number(row?.campaigns ?? 0),
    activeAgents: Number(row?.active_agents ?? 0),
    callsToday: Number(row?.calls_today ?? 0),
    suppressionEntries: Number(row?.suppression_entries ?? 0),
    liveCalls: Number(row?.live_calls ?? 0)
  };
}

async function getCampaigns(pool: pg.Pool): Promise<AdminOverviewResponse["campaigns"]> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: AdminOverviewResponse["campaigns"][number]["status"];
    loaded: string;
    callable: string;
  }>(`
    select
      campaigns.id,
      campaigns.name,
      campaigns.status,
      count(contacts.id) as loaded,
      count(contacts.id) filter (
        where contacts.status not in ('completed', 'suppressed')
          and suppression_entries.id is null
      ) as callable
    from campaigns
    left join contacts on contacts.campaign_id = campaigns.id
    left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
    group by campaigns.id
    order by campaigns.created_at desc
    limit 12
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    loaded: Number(row.loaded),
    callable: Number(row.callable)
  }));
}

async function getCampaignOverviewItem(
  pool: pg.Pool,
  campaignId: string
): Promise<AdminOverviewResponse["campaigns"][number] | null> {
  const result = await pool.query<{
    id: string;
    name: string;
    status: AdminOverviewResponse["campaigns"][number]["status"];
    loaded: string;
    callable: string;
  }>(
    `
      select
        campaigns.id,
        campaigns.name,
        campaigns.status,
        count(contacts.id) as loaded,
        count(contacts.id) filter (
          where contacts.status not in ('completed', 'suppressed')
            and suppression_entries.id is null
        ) as callable
      from campaigns
      left join contacts on contacts.campaign_id = campaigns.id
      left join suppression_entries on suppression_entries.normalized_phone_number = contacts.normalized_phone_number
      where campaigns.id = $1
      group by campaigns.id
    `,
    [campaignId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    loaded: Number(row.loaded),
    callable: Number(row.callable)
  };
}

async function getRecordings(pool: pg.Pool): Promise<AdminOverviewResponse["recordings"]> {
  const result = await pool.query<{
    id: string;
    name: string;
    runtime_file_path: string;
    duration_seconds: number;
    file_size_bytes: number;
    is_default: boolean;
    is_active: boolean;
  }>(`
    select id, name, runtime_file_path, duration_seconds, file_size_bytes, is_default, is_active
    from recordings
    where is_active = true
    order by is_default desc, created_at desc
    limit 12
  `);

  return result.rows.map(mapRecordingRow);
}

async function createRecording(
  pool: pg.Pool,
  input: {
    name: string;
    filePath: string;
    runtimeFilePath: string;
    durationSeconds: number;
    fileSizeBytes: number;
    makeDefault: boolean;
  }
): Promise<AdminOverviewResponse["recordings"][number]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const countResult = await client.query<{ count: string }>("select count(*) from recordings");
    const shouldMakeDefault = input.makeDefault || Number(countResult.rows[0]?.count ?? 0) === 0;

    if (shouldMakeDefault) {
      await client.query("update recordings set is_default = false, updated_at = now()");
    }

    const result = await client.query<RecordingRow>(
      `
        insert into recordings (name, file_path, runtime_file_path, is_default, is_active, duration_seconds, file_size_bytes)
        values ($1, $2, $3, $4, true, $5, $6)
        returning id, name, runtime_file_path, duration_seconds, file_size_bytes, is_default, is_active
      `,
      [input.name, input.filePath, input.runtimeFilePath, shouldMakeDefault, input.durationSeconds, input.fileSizeBytes]
    );
    await client.query("commit");
    return mapRecordingRow(result.rows[0]);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function setDefaultRecording(
  pool: pg.Pool,
  recordingId: string
): Promise<AdminOverviewResponse["recordings"][number] | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const exists = await client.query<{ id: string }>(
      "select id from recordings where id = $1 and is_active = true",
      [recordingId]
    );
    if (!exists.rowCount) {
      await client.query("rollback");
      return null;
    }

    await client.query("update recordings set is_default = false, updated_at = now()");
    const result = await client.query<RecordingRow>(
      `
        update recordings
        set is_default = true, updated_at = now()
        where id = $1
        returning id, name, runtime_file_path, duration_seconds, file_size_bytes, is_default, is_active
      `,
      [recordingId]
    );
    await client.query("commit");
    return mapRecordingRow(result.rows[0]);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteRecording(pool: pg.Pool, recordingId: string): Promise<{ filePath: string } | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string; file_path: string; is_default: boolean }>(
      "select id, file_path, is_default from recordings where id = $1 and is_active = true",
      [recordingId]
    );
    const row = existing.rows[0];
    if (!row) {
      await client.query("rollback");
      return null;
    }

    await client.query(
      `
        update recordings
        set is_active = false, is_default = false, updated_at = now()
        where id = $1
      `,
      [recordingId]
    );

    if (row.is_default) {
      await client.query(
        `
          update recordings
          set is_default = true, updated_at = now()
          where id = (
            select id
            from recordings
            where is_active = true
            order by created_at desc
            limit 1
          )
        `
      );
    }

    await client.query("commit");
    return { filePath: row.file_path };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function getRecordingAudioFile(
  pool: pg.Pool,
  recordingId: string
): Promise<{ filePath: string; filename: string } | null> {
  const result = await pool.query<{ file_path: string; name: string }>(
    `
      select file_path, name
      from recordings
      where id = $1 and is_active = true
    `,
    [recordingId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    filePath: row.file_path,
    filename: sanitizeDownloadFilename(row.name, extname(row.file_path))
  };
}

type RecordingRow = {
  id: string;
  name: string;
  runtime_file_path: string;
  duration_seconds: number;
  file_size_bytes: number;
  is_default: boolean;
  is_active: boolean;
};

function mapRecordingRow(row: RecordingRow): AdminOverviewResponse["recordings"][number] {
  return {
    id: row.id,
    name: row.name,
    durationSeconds: row.duration_seconds,
    fileSizeBytes: row.file_size_bytes,
    runtimeFilePath: row.runtime_file_path,
    status: row.is_default ? "default" : row.is_active ? "ready" : "inactive"
  };
}

function getSupportedRecordingExtension(filename: string): ".mp3" | ".wav" | null {
  const extension = extname(filename).toLowerCase();
  return extension === ".mp3" || extension === ".wav" ? extension : null;
}

function normalizeRecordingName(value: string | undefined, filename: string): string {
  const rawName = value?.trim() || basename(filename, extname(filename));
  return rawName.replace(/\s+/g, " ").slice(0, 160) || "Voicemail recording";
}

function getMultipartFieldValue(field: unknown): string | undefined {
  if (Array.isArray(field)) {
    return getMultipartFieldValue(field[0]);
  }
  if (field && typeof field === "object" && "value" in field && typeof field.value === "string") {
    return field.value;
  }
  return undefined;
}

function parseBooleanField(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "on";
}

function getRecordingContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".mp3") {
    return "audio/mpeg";
  }
  if (extension === ".wav") {
    return "audio/wav";
  }
  return "application/octet-stream";
}

function sanitizeDownloadFilename(name: string, extension: string): string {
  const safeName = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safeName || "voicemail"}${extension}`;
}

function detectAudioDurationSeconds(buffer: Buffer, extension: ".mp3" | ".wav"): number {
  const duration = extension === ".wav" ? detectWavDurationSeconds(buffer) : detectMp3DurationSeconds(buffer);
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(duration));
}

function detectWavDurationSeconds(buffer: Buffer): number {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return 0;
  }

  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkDataOffset + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(chunkDataOffset + 8);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : 0;
}

function detectMp3DurationSeconds(buffer: Buffer): number {
  let offset = getMp3AudioStartOffset(buffer);
  let duration = 0;
  let frames = 0;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }

    const frame = parseMp3FrameHeader(buffer, offset);
    if (!frame) {
      offset += 1;
      continue;
    }

    duration += frame.samplesPerFrame / frame.sampleRate;
    frames += 1;
    offset += frame.frameLength;
  }

  return frames > 0 ? duration : 0;
}

function getMp3AudioStartOffset(buffer: Buffer): number {
  if (buffer.length < 10 || buffer.toString("ascii", 0, 3) !== "ID3") {
    return 0;
  }
  const size =
    ((buffer[6] & 0x7f) << 21) |
    ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) |
    (buffer[9] & 0x7f);
  return 10 + size;
}

function parseMp3FrameHeader(
  buffer: Buffer,
  offset: number
): { frameLength: number; sampleRate: number; samplesPerFrame: number } | null {
  const versionBits = (buffer[offset + 1] >> 3) & 0x03;
  const layerBits = (buffer[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
  const padding = (buffer[offset + 2] >> 1) & 0x01;

  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }

  const version: "mpeg1" | "mpeg2" | "mpeg25" = versionBits === 3 ? "mpeg1" : versionBits === 2 ? "mpeg2" : "mpeg25";
  const layer: 1 | 2 | 3 = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const sampleRate = getMp3SampleRate(version, sampleRateIndex);
  const bitrate = getMp3Bitrate(version, layer, bitrateIndex);
  if (!sampleRate || !bitrate) {
    return null;
  }

  if (layer === 1) {
    return {
      frameLength: Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4,
      sampleRate,
      samplesPerFrame: 384
    };
  }

  const samplesPerFrame = layer === 3 && version !== "mpeg1" ? 576 : 1152;
  const coefficient = layer === 3 && version !== "mpeg1" ? 72 : 144;
  return {
    frameLength: Math.floor((coefficient * bitrate * 1000) / sampleRate + padding),
    sampleRate,
    samplesPerFrame
  };
}

function getMp3SampleRate(version: "mpeg1" | "mpeg2" | "mpeg25", index: number): number {
  const rates = {
    mpeg1: [44100, 48000, 32000],
    mpeg2: [22050, 24000, 16000],
    mpeg25: [11025, 12000, 8000]
  };
  return rates[version][index] ?? 0;
}

function getMp3Bitrate(version: "mpeg1" | "mpeg2" | "mpeg25", layer: 1 | 2 | 3, index: number): number {
  const mpeg1 = {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  };
  const mpeg2 = {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  };
  return (version === "mpeg1" ? mpeg1[layer] : mpeg2[layer])[index] ?? 0;
}

async function getUsers(pool: pg.Pool): Promise<PublicUser[]> {
  const result = await pool.query<PublicUser>(`
    select id, email, name, role
    from users
    order by created_at desc
    limit 24
  `);
  return result.rows;
}

async function getCallHistory(pool: pg.Pool): Promise<AdminOverviewResponse["callHistory"]> {
  const result = await pool.query<{
    id: string;
    lead_name: string | null;
    agent_name: string | null;
    outcome: CallOutcome | null;
    duration_seconds: number | null;
    call_recording_path: string | null;
  }>(`
    select
      calls.id,
      contacts.display_name as lead_name,
      users.name as agent_name,
      calls.outcome,
      calls.call_recording_path,
      extract(epoch from (coalesce(calls.ended_at, now()) - coalesce(calls.answered_at, calls.started_at, calls.created_at)))::int as duration_seconds
    from calls
    left join contacts on contacts.id = calls.contact_id
    left join agents on agents.id = calls.agent_id
    left join users on users.id = agents.user_id
    order by calls.created_at desc
    limit 20
  `);

  return result.rows.map((row) => ({
    id: row.id,
    leadName: row.lead_name ?? "Manual dial",
    agentName: row.agent_name ?? "Unassigned",
    outcome: row.outcome ?? "failed",
    durationSeconds: row.duration_seconds ?? 0,
    callRecordingPath: row.call_recording_path
  }));
}

async function getSuppression(pool: pg.Pool): Promise<AdminOverviewResponse["suppression"]> {
  const result = await pool.query<{
    id: string;
    phone_number: string;
    reason: string | null;
  }>(`
    select id, phone_number, reason
    from suppression_entries
    order by created_at desc
    limit 20
  `);

  return result.rows.map((row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    reason: row.reason ?? "Suppressed"
  }));
}

async function getCsvImports(pool: pg.Pool): Promise<CsvImportHistoryResponse["imports"]> {
  const result = await pool.query<{
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
  }>(`
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
    order by csv_imports.created_at desc
    limit 20
  `);

  return result.rows.map((row) => ({
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name ?? "Deleted campaign",
    filename: row.filename,
    status: row.status,
    totalRows: Number(row.total_rows),
    importedRows: Number(row.imported_rows),
    failedRows: Number(row.failed_rows),
    duplicateRows: Number(row.field_mapping_json?.duplicateRows ?? 0),
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString()
  }));
}

async function getCsvImportDetail(pool: pg.Pool, importId: string): Promise<CsvImportDetailResponse | null> {
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

  return {
    import: {
      id: row.id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name ?? "Deleted campaign",
      filename: row.filename,
      status: row.status,
      totalRows: Number(row.total_rows),
      importedRows: Number(row.imported_rows),
      failedRows: Number(row.failed_rows),
      duplicateRows: Number(row.field_mapping_json?.duplicateRows ?? 0),
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString()
    },
    failures: await getCsvImportFailures(pool, importId)
  };
}

async function getCsvImportFailures(pool: pg.Pool, importId: string): Promise<CsvImportFailure[]> {
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
      limit 50
    `,
    [importId]
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
    company: row.company ?? "Unmapped company",
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
  query: { q: string; status: "all" | "ready" | "suppressed" | "completed" }
): Promise<CampaignContactsResponse> {
  const search = query.q.trim();
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
      limit 50
    `,
    [campaignId, search, query.status]
  );

  return {
    total: Number(result.rows[0]?.total_count ?? 0),
    contacts: result.rows.map((row) => ({
      id: row.id,
      name: row.display_name ?? "Unknown contact",
      company: row.company ?? "Unmapped company",
      phoneNumber: row.phone_number,
      status: row.contact_status,
      createdAt: row.created_at.toISOString(),
      fields: Object.entries(row.mapped_fields_json ?? {})
        .slice(0, 8)
        .map(([label, value]) => ({ label, value: String(value) }))
    }))
  };
}

function buildDemoAgentDeskResponse(user: PublicUser): AgentDeskResponse {
  const campaign = {
    id: "campaign_demo_solar_followup",
    name: "Solar Follow-up",
    status: "active" as const,
    callableLeads: 248,
    manualDialingEnabled: true,
    callRecordingEnabled: true
  };

  return {
    user,
    campaign,
    availableCampaigns: [campaign],
    softphone: {
      registered: true,
      microphoneAllowed: true,
      status: "in_call"
    },
    metrics: {
      todayCalls: 37,
      voicemailsDropped: 11,
      suppressed: 4
    },
    leads: buildDemoLeads(),
    activeCall: {
      id: "call_demo_active",
      state: "bridged",
      leadName: "Avery Johnson",
      phoneNumber: "+1 415 555 0148",
      durationSeconds: 222,
      status: "bridged",
      voicemailSignal: "detected",
      recordingName: "Solar Intro v3",
      timeline: [
        { at: "00:00", label: "Agent leg answered" },
        { at: "00:18", label: "Customer leg answered" },
        { at: "00:21", label: "Bridge established" },
        { at: "00:24", label: "Call recording started" },
        { at: "03:37", label: "VM/beep signal detected" }
      ]
    }
  };
}

function buildDemoLeads(): LeadSummary[] {
  const leads = [
    {
      id: "lead_avery",
      name: "Avery Johnson",
      company: "North Bay Solar",
      phoneNumber: "+1 415 555 0148",
      status: "calling" as const,
      fields: [
        { label: "Company", value: "North Bay Solar" },
        { label: "Plan", value: "Residential retrofit" },
        { label: "Timezone", value: "America/Los_Angeles" },
        { label: "Last note", value: "Asked for callback after 2 PM" },
        { label: "CSV source", value: "july-solar-followups.csv" }
      ]
    },
    {
      id: "lead_morgan",
      name: "Morgan Lee",
      company: "Sunstone Homes",
      phoneNumber: "+1 628 555 0191",
      status: "ready" as const,
      fields: []
    },
    {
      id: "lead_taylor",
      name: "Taylor Brooks",
      company: "East Bay Roofing",
      phoneNumber: "+1 510 555 0172",
      status: "ready" as const,
      fields: []
    },
    {
      id: "lead_sam",
      name: "Sam Patel",
      company: "Harbor Lofts",
      phoneNumber: "+1 408 555 0120",
      status: "suppressed" as const,
      fields: []
    },
    {
      id: "lead_jordan",
      name: "Jordan Kim",
      company: "Greenline Design",
      phoneNumber: "+1 650 555 0184",
      status: "ready" as const,
      fields: []
    }
  ];

  return leads;
}

function mapCallStatus(state: CallState): NonNullable<AgentDeskResponse["activeCall"]>["status"] {
  if (state === "created" || state === "agent_ringing" || state === "agent_answered" || state === "customer_dialing") {
    return "dialing";
  }
  if (state === "customer_ringing") {
    return "ringing";
  }
  if (state === "voicemail_drop_requested" || state === "voicemail_playback_started") {
    return "voicemail_drop";
  }
  if (state === "completed") {
    return "completed";
  }
  return "bridged";
}

function mapVoicemailSignal(status: string | null): NonNullable<AgentDeskResponse["activeCall"]>["voicemailSignal"] {
  if (status === "detected") {
    return "detected";
  }
  if (status === "possible") {
    return "possible";
  }
  return "none";
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function humanize(value: string): string {
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

type PhoneNormalizationResult =
  | { ok: true; number: string }
  | { ok: false; reason: string };

function normalizePhoneNumber(value: string, defaultCountryCode?: string): PhoneNormalizationResult {
  const raw = value.trim();
  if (!raw) {
    return { ok: false, reason: "Missing phone number" };
  }

  const prepared = raw.replace(/^00(?=\d)/, "+");
  const internationalPhoneNumber = normalizeInternationalPhoneNumber(prepared);
  const countryCode = normalizeCountryCode(defaultCountryCode);
  if (defaultCountryCode && !countryCode) {
    return { ok: false, reason: `Unsupported default country ${defaultCountryCode.trim().toUpperCase()}` };
  }
  if (!internationalPhoneNumber && !countryCode) {
    return { ok: false, reason: "Local number requires a default country" };
  }

  const parsed = internationalPhoneNumber
    ? parsePhoneNumberFromString(internationalPhoneNumber)
    : parsePhoneNumberFromString(prepared, countryCode);
  if (!parsed?.isValid()) {
    return {
      ok: false,
      reason: internationalPhoneNumber
        ? "Invalid international phone number"
        : `Invalid phone number for ${countryCode}`
    };
  }

  return { ok: true, number: parsed.number };
}

function normalizeInternationalPhoneNumber(value: string): string | undefined {
  if (!value.startsWith("+")) {
    return undefined;
  }
  return `+${value.slice(1).replace(/\D/g, "")}`;
}

function normalizeCountryCode(value?: string): CountryCode | undefined {
  if (!value) {
    return undefined;
  }
  const countryCode = value.trim().toUpperCase();
  return isSupportedCountry(countryCode) ? (countryCode as CountryCode) : undefined;
}
