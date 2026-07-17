import type { FastifySchema } from "fastify";

type JsonSchema = Record<string, unknown>;
type DocumentedRouteSchema = FastifySchema & {
  summary: string;
  description: string;
};

type RouteOptions = {
  body?: JsonSchema;
  params?: JsonSchema;
  querystring?: JsonSchema;
  success?: JsonSchema;
  successStatus?: number;
  errors?: number[];
  consumes?: string[];
  produces?: string[];
};

const routes = new Map<string, DocumentedRouteSchema>();

const ref = (name: string): JsonSchema => ({ $ref: `${name}#` });
const error = ref("ErrorResponse");
const emptyResponse: JsonSchema = { type: "null", description: "No response body" };
const binaryResponse: JsonSchema = { type: "string", format: "binary" };
const textResponse: JsonSchema = { type: "string" };

const uuid = (description: string): JsonSchema => ({ type: "string", format: "uuid", description });
const optionalUuid = (description: string): JsonSchema => ({
  type: "string",
  format: "uuid",
  description
});
const dateTime = (description: string): JsonSchema => ({
  type: "string",
  format: "date-time",
  description
});
const optionalString = (description: string, maxLength?: number): JsonSchema => ({
  type: "string",
  description,
  ...(maxLength ? { maxLength } : {})
});

function object(
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
  description?: string
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
    ...(description ? { description } : {})
  };
}

function params(name: string, description: string): JsonSchema {
  return object({ [name]: uuid(description) });
}

function pagination(defaultPageSize = 25): Record<string, JsonSchema> {
  return {
    page: { type: "integer", minimum: 1, default: 1, description: "One-based page number" },
    pageSize: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: defaultPageSize,
      description: "Number of items per page"
    }
  };
}

function add(
  method: string,
  url: string,
  summary: string,
  description: string,
  options: RouteOptions = {}
): void {
  const successStatus = options.successStatus ?? 200;
  const response: Record<string, JsonSchema> = {
    [successStatus]: options.success ?? emptyResponse
  };
  for (const status of options.errors ?? []) response[status] = error;
  routes.set(`${method} ${url}`, {
    summary,
    description,
    body: options.body,
    params: options.params,
    querystring: options.querystring,
    consumes: options.consumes,
    produces: options.produces,
    response
  });
}

const adminErrors = [400, 401, 403, 500];
const agentErrors = [400, 401, 500];
const callParams = params("callId", "Call identifier");
const campaignParams = params("campaignId", "Campaign identifier");
const contactParams = params("contactId", "Contact identifier");
const recordingParams = params("recordingId", "Voicemail recording identifier");

add("GET", "/", "Get API service status", "Returns the API service name and basic status.", {
  success: ref("RootServiceResponse")
});
add("GET", "/health/live", "Check liveness", "Reports whether the API process is running.", {
  success: ref("LiveHealthResponse")
});
for (const url of ["/health", "/health/ready"]) {
  add("GET", url, "Check readiness", "Checks PostgreSQL, FreeSWITCH ESL, and event-listener readiness.", {
    success: ref("HealthResponse"),
    errors: [503]
  });
}
add(
  "GET",
  "/metrics",
  "Read Prometheus metrics",
  "Returns API and telephony metrics in Prometheus text format.",
  {
    success: textResponse,
    produces: ["text/plain"]
  }
);

add(
  "POST",
  "/auth/login",
  "Log in",
  "Authenticates a user and returns a bearer token while setting the session cookie.",
  {
    body: object({
      email: { type: "string", format: "email", description: "User email address" },
      password: { type: "string", minLength: 1, format: "password", description: "User password" }
    }),
    success: ref("LoginResponse"),
    errors: [400, 401, 429, 500]
  }
);
add("POST", "/auth/logout", "Log out", "Clears the current browser session cookie.", {
  successStatus: 204
});
add(
  "GET",
  "/auth/me",
  "Get current user",
  "Returns the authenticated user represented by the bearer token or session cookie.",
  {
    success: ref("CurrentUserResponse"),
    errors: [401, 500]
  }
);

add(
  "POST",
  "/admin/users",
  "Create user",
  "Creates an administrator or agent user and provisions agent telephony data when needed.",
  {
    body: ref("CreateUserRequest"),
    success: ref("CreateUserResponse"),
    successStatus: 201,
    errors: [...adminErrors, 409]
  }
);
add(
  "PATCH",
  "/admin/users/:userId",
  "Update user",
  "Updates identity, role, active state, or password for a user.",
  {
    params: params("userId", "User identifier"),
    body: ref("UpdateUserRequest"),
    success: ref("UpdateUserResponse"),
    errors: [...adminErrors, 404, 409]
  }
);
add(
  "DELETE",
  "/admin/users/:userId",
  "Deactivate user",
  "Deactivates a user after active-call safety checks.",
  {
    params: params("userId", "User identifier"),
    success: ref("DeleteResponse"),
    errors: [...adminErrors, 404, 409]
  }
);

add(
  "GET",
  "/admin/system-settings",
  "Get runtime settings",
  "Returns mutable system settings and available alert channels.",
  {
    success: ref("AdminSystemSettings"),
    errors: [401, 403, 500]
  }
);
add(
  "PATCH",
  "/admin/system-settings",
  "Update runtime settings",
  "Replaces the mutable runtime settings and renders dependent monitoring configuration.",
  {
    body: ref("UpdateAdminSystemSettingsRequest"),
    success: ref("AdminSystemSettings"),
    errors: [...adminErrors, 409]
  }
);

add(
  "GET",
  "/agent/desk",
  "Get Agent Desk",
  "Returns the authenticated agent workflow state, leads, active call, and recent activity.",
  {
    querystring: object({ campaignId: optionalUuid("Selected campaign identifier") }, []),
    success: ref("AgentDeskResponse"),
    errors: [400, 401, 500]
  }
);
add(
  "PATCH",
  "/agent/availability",
  "Set agent availability",
  "Sets the agent to available or paused and returns refreshed Agent Desk state.",
  {
    body: ref("UpdateAgentAvailabilityRequest"),
    success: ref("AgentDeskResponse"),
    errors: [...agentErrors, 409]
  }
);
add(
  "GET",
  "/agent/softphone/provisioning",
  "Get softphone provisioning",
  "Returns authenticated SIP/WebRTC and ICE credentials for the current agent.",
  {
    success: ref("SoftphoneProvisioningResponse"),
    errors: [401, 500]
  }
);
add(
  "PUT",
  "/agent/calls/:callId/browser-media",
  "Save browser media telemetry",
  "Upserts cumulative browser WebRTC and microphone telemetry for an owned call.",
  {
    params: callParams,
    body: ref("BrowserMediaTelemetryRequest"),
    successStatus: 204,
    errors: [...agentErrors, 404]
  }
);
add(
  "GET",
  "/agent/events",
  "Stream live refresh events",
  "Opens a server-sent event stream used to refresh authenticated Agent Desk state.",
  {
    success: textResponse,
    produces: ["text/event-stream"],
    errors: [401, 500]
  }
);

add(
  "GET",
  "/admin/overview",
  "Get admin overview",
  "Returns operational statistics and compact campaign, recording, user, call, and suppression summaries.",
  {
    success: ref("AdminOverviewResponse"),
    errors: [401, 403, 500]
  }
);
add(
  "GET",
  "/admin/analytics",
  "Get admin analytics",
  "Returns source-backed product and telephony analytics for a bounded period.",
  {
    querystring: object(
      {
        from: dateTime("Inclusive period start; defaults to seven days before to"),
        to: dateTime("Inclusive period end; defaults to now"),
        campaignId: optionalUuid("Optional campaign filter"),
        timeZone: { type: "string", maxLength: 100, default: "UTC", description: "IANA time zone" }
      },
      []
    ),
    success: ref("AdminAnalyticsResponse"),
    errors: adminErrors
  }
);

const libraryQuery = object(
  {
    q: { type: "string", maxLength: 160, default: "", description: "Case-insensitive search text" },
    ...pagination(25)
  },
  []
);
add("GET", "/admin/campaigns", "List campaigns", "Returns a searchable, paginated campaign library.", {
  querystring: libraryQuery,
  success: ref("AdminCampaignListResponse"),
  errors: adminErrors
});
add(
  "GET",
  "/admin/recordings",
  "List voicemail recordings",
  "Returns a searchable, paginated voicemail recording library.",
  {
    querystring: libraryQuery,
    success: ref("AdminRecordingListResponse"),
    errors: adminErrors
  }
);
add("GET", "/admin/users", "List users", "Returns a searchable, paginated user library.", {
  querystring: libraryQuery,
  success: ref("AdminUserListResponse"),
  errors: adminErrors
});

const callHistoryQuery = object(
  {
    ...pagination(25),
    q: optionalString("Search lead, phone, campaign, or agent", 160),
    campaignId: optionalUuid("Campaign filter"),
    agentId: optionalUuid("Agent filter"),
    outcome: { $ref: "CallOutcome#", description: "Terminal outcome filter" },
    from: dateTime("Earliest call creation time"),
    to: dateTime("Latest call creation time"),
    voicemail: { type: "string", enum: ["drop", "signal"], description: "Voicemail activity filter" },
    recording: {
      type: "string",
      enum: ["available", "missing"],
      description: "Recording availability filter"
    },
    avmdReview: {
      type: "string",
      enum: ["needs_review", "reviewed", "uncertain"],
      description: "AVMD review filter"
    }
  },
  []
);
add("GET", "/admin/calls", "List call history", "Returns filtered and paginated durable call history.", {
  querystring: callHistoryQuery,
  success: ref("CallHistoryResponse"),
  errors: adminErrors
});
add(
  "GET",
  "/admin/calls/export.csv",
  "Export call history",
  "Downloads filtered call history as CSV, subject to the configured row limit.",
  {
    querystring: object(
      Object.fromEntries(
        Object.entries((callHistoryQuery.properties as Record<string, JsonSchema>) ?? {}).filter(
          ([key]) => !["page", "pageSize"].includes(key)
        )
      ),
      []
    ),
    success: textResponse,
    produces: ["text/csv"],
    errors: [...adminErrors, 413]
  }
);
add(
  "GET",
  "/admin/calls/:callId",
  "Get call detail",
  "Returns durable call state, legs, timeline, media quality, recording, PCAP, and AVMD review data.",
  {
    params: callParams,
    success: ref("CallDetailResponse"),
    errors: [...adminErrors, 404]
  }
);
add(
  "PUT",
  "/admin/calls/:callId/avmd-review",
  "Review AVMD result",
  "Creates or updates the human review of an AVMD-eligible completed call.",
  {
    params: callParams,
    body: ref("UpsertCallAvmdReviewRequest"),
    success: ref("CallAvmdReview"),
    errors: [...adminErrors, 404, 409]
  }
);

const mediaTicketQuery = object(
  { ticket: { type: "string", minLength: 32, maxLength: 200, description: "Short-lived media ticket" } },
  []
);
add(
  "GET",
  "/admin/calls/:callId/recording",
  "Stream call recording",
  "Streams an authorized call recording with byte-range support.",
  {
    params: callParams,
    querystring: mediaTicketQuery,
    success: binaryResponse,
    produces: ["audio/wav"],
    errors: [...adminErrors, 404, 409, 416]
  }
);
add(
  "POST",
  "/admin/calls/:callId/recording-ticket",
  "Issue call recording ticket",
  "Issues a short-lived URL for browser playback of a call recording.",
  {
    params: callParams,
    success: ref("MediaTicketResponse"),
    errors: [...adminErrors, 404]
  }
);
add(
  "GET",
  "/admin/calls/:callId/pcap",
  "Download call PCAP",
  "Downloads the available packet capture for a call.",
  {
    params: callParams,
    success: binaryResponse,
    produces: ["application/vnd.tcpdump.pcap", "application/octet-stream"],
    errors: [...adminErrors, 404]
  }
);
add(
  "GET",
  "/admin/freeswitch/diagnostics",
  "Get FreeSWITCH diagnostics",
  "Checks ESL, trunk configuration, and safe-test availability without placing a call.",
  {
    success: ref("FreeSwitchDiagnosticsResponse"),
    errors: [401, 403, 500]
  }
);
add(
  "POST",
  "/admin/freeswitch/safe-test",
  "Run safe FreeSWITCH test",
  "Runs non-traffic ESL API and background-job checks.",
  {
    success: ref("FreeSwitchSafeTestResponse"),
    errors: [401, 403, 500]
  }
);
add(
  "POST",
  "/admin/retention/run",
  "Run retention",
  "Previews or executes configured call-log, recording, and PCAP retention.",
  {
    body: object(
      { dryRun: { type: "boolean", default: true, description: "Preview deletions without changing data" } },
      []
    ),
    success: ref("RetentionRunResponse"),
    errors: [...adminErrors, 409]
  }
);

add(
  "GET",
  "/admin/audit-events",
  "List admin audit events",
  "Returns filtered audit events for successful administrator mutations.",
  {
    querystring: object(
      {
        ...pagination(25),
        actorId: optionalUuid("Actor user identifier"),
        method: { type: "string", enum: ["DELETE", "PATCH", "POST", "PUT"], description: "HTTP method" },
        dateFrom: dateTime("Inclusive creation-time lower bound"),
        dateTo: dateTime("Inclusive creation-time upper bound")
      },
      []
    ),
    success: ref("AdminAuditResponse"),
    errors: adminErrors
  }
);
add(
  "GET",
  "/admin/csv-imports",
  "List CSV imports",
  "Returns searchable and paginated contact CSV import history.",
  {
    querystring: object(
      {
        q: { type: "string", maxLength: 160, default: "", description: "Filename or campaign search" },
        ...pagination(20)
      },
      []
    ),
    success: ref("CsvImportHistoryResponse"),
    errors: adminErrors
  }
);
add(
  "GET",
  "/admin/csv-imports/:importId",
  "Get CSV import detail",
  "Returns one import and a paginated failure list.",
  {
    params: params("importId", "CSV import identifier"),
    querystring: object(
      {
        failurePage: { type: "integer", minimum: 1, default: 1, description: "Failure page number" },
        failurePageSize: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
          description: "Failures per page"
        }
      },
      []
    ),
    success: ref("CsvImportDetailResponse"),
    errors: [...adminErrors, 404]
  }
);
add(
  "GET",
  "/admin/campaigns/:campaignId/contacts",
  "List campaign contacts",
  "Returns searchable and paginated contacts for a campaign.",
  {
    params: campaignParams,
    querystring: object(
      {
        q: { type: "string", default: "", description: "Name, company, or phone search" },
        status: {
          type: "string",
          enum: ["all", "ready", "suppressed", "completed"],
          default: "all",
          description: "Contact workflow status"
        },
        ...pagination(50)
      },
      []
    ),
    success: ref("CampaignContactsResponse"),
    errors: [...adminErrors, 404]
  }
);

add(
  "POST",
  "/agent/manual-dial/validate",
  "Validate manual destination",
  "Normalizes a destination and reports validation, suppression, and campaign checks without calling.",
  {
    body: ref("StartManualCallRequest"),
    success: ref("ManualDialValidationResponse"),
    errors: agentErrors
  }
);
add(
  "POST",
  "/agent/manual-dial/start",
  "Start manual call",
  "Starts an authorized manual outbound call and returns refreshed Agent Desk state.",
  {
    body: ref("StartManualCallRequest"),
    success: ref("AgentDeskResponse"),
    errors: [...agentErrors, 409]
  }
);
add(
  "POST",
  "/agent/call-next",
  "Call next lead",
  "Selects and starts the next callable lead in the requested campaign.",
  {
    body: ref("StartNextCallRequest"),
    success: ref("AgentDeskResponse"),
    errors: [...agentErrors, 409]
  }
);
add(
  "POST",
  "/agent/leads/:contactId/call",
  "Call selected lead",
  "Starts a call to a specific contact when it is eligible.",
  {
    params: contactParams,
    success: ref("AgentDeskResponse"),
    errors: [...agentErrors, 404, 409]
  }
);
add(
  "POST",
  "/agent/calls/:callId/end",
  "End active call",
  "Ends an owned active call and returns refreshed Agent Desk state.",
  {
    params: callParams,
    body: ref("EndCallRequest"),
    success: ref("AgentDeskResponse"),
    errors: [...agentErrors, 404]
  }
);
add(
  "POST",
  "/agent/calls/:callId/drop-voicemail",
  "Drop voicemail",
  "Starts voicemail playback on the customer leg and releases the agent when safe.",
  {
    params: callParams,
    body: ref("DropVoicemailRequest"),
    success: ref("AgentDeskResponse"),
    errors: [...agentErrors, 404, 409, 502]
  }
);
add(
  "POST",
  "/agent/calls/:callId/dtmf",
  "Send DTMF",
  "Sends one supported DTMF digit to the active customer leg.",
  {
    params: callParams,
    body: ref("SendDtmfRequest"),
    success: ref("AgentDeskResponse"),
    errors: [...agentErrors, 404, 409, 502]
  }
);

add(
  "POST",
  "/admin/campaigns",
  "Create campaign",
  "Creates a campaign with dialing, recording, and early-media AVMD policy.",
  {
    body: ref("CreateCampaignRequest"),
    success: object({ item: ref("CampaignSummary") }),
    successStatus: 201,
    errors: [...adminErrors, 409]
  }
);
add(
  "PATCH",
  "/admin/campaigns/:campaignId",
  "Update campaign",
  "Replaces a campaign's name, status, and dialing policies.",
  {
    params: campaignParams,
    body: ref("UpdateCampaignRequest"),
    success: object({ item: ref("CampaignSummary") }),
    errors: [...adminErrors, 404]
  }
);
add(
  "DELETE",
  "/admin/campaigns/:campaignId",
  "Delete campaign",
  "Deletes an unused campaign after active-call safety checks.",
  {
    params: campaignParams,
    success: ref("DeleteResponse"),
    errors: [...adminErrors, 404, 409]
  }
);

const recordingUpload = object(
  {
    file: { type: "string", format: "binary", description: "WAV or MP3 recording file" },
    name: { type: "string", maxLength: 160, description: "Display name; defaults to the filename" },
    makeDefault: { type: "boolean", default: false, description: "Make this the default voicemail recording" }
  },
  ["file"]
);
add(
  "POST",
  "/admin/recordings",
  "Upload voicemail recording",
  "Uploads and converts a WAV or MP3 file into the canonical voicemail format.",
  {
    body: recordingUpload,
    consumes: ["multipart/form-data"],
    success: ref("CreateRecordingResponse"),
    successStatus: 201,
    errors: [...adminErrors, 413, 503]
  }
);
add(
  "PATCH",
  "/admin/recordings/:recordingId/default",
  "Set default recording",
  "Makes a voicemail recording the default for new drops.",
  {
    params: recordingParams,
    success: object({ item: ref("RecordingSummary") }),
    errors: [...adminErrors, 404]
  }
);
add(
  "GET",
  "/admin/recordings/:recordingId/audio",
  "Stream voicemail recording",
  "Streams an authorized voicemail recording with byte-range support.",
  {
    params: recordingParams,
    querystring: mediaTicketQuery,
    success: binaryResponse,
    produces: ["audio/wav"],
    errors: [...adminErrors, 404, 409, 416]
  }
);
add(
  "POST",
  "/admin/recordings/:recordingId/audio-ticket",
  "Issue voicemail audio ticket",
  "Issues a short-lived URL for browser playback of a voicemail recording.",
  {
    params: recordingParams,
    success: ref("MediaTicketResponse"),
    errors: [...adminErrors, 404]
  }
);
add(
  "DELETE",
  "/admin/recordings/:recordingId",
  "Delete voicemail recording",
  "Deletes an unused voicemail recording and its file.",
  {
    params: recordingParams,
    success: ref("DeleteResponse"),
    errors: [...adminErrors, 404, 409, 503]
  }
);

add("POST", "/admin/contacts", "Create campaign contact", "Normalizes and adds one contact to a campaign.", {
  body: ref("CreateContactRequest"),
  success: object({ item: ref("LeadSummary") }),
  successStatus: 201,
  errors: [...adminErrors, 404, 409]
});
add(
  "POST",
  "/admin/contacts/:contactId/suppress",
  "Suppress campaign contact",
  "Adds the contact's number to the global suppression list.",
  {
    params: contactParams,
    body: ref("SuppressContactRequest"),
    success: object({ item: ref("CampaignContactListItem") }),
    errors: [...adminErrors, 404]
  }
);
add(
  "POST",
  "/admin/contacts/:contactId/complete",
  "Complete campaign contact",
  "Marks a campaign contact completed.",
  {
    params: contactParams,
    success: object({ item: ref("CampaignContactListItem") }),
    errors: [...adminErrors, 404]
  }
);
add(
  "POST",
  "/admin/campaigns/:campaignId/import-csv",
  "Import contacts from CSV text",
  "Imports the minimal name and phone CSV contract supplied as JSON text.",
  {
    params: campaignParams,
    body: ref("ImportCsvRequest"),
    success: ref("ImportCsvResponse"),
    successStatus: 201,
    errors: [...adminErrors, 404]
  }
);
add(
  "POST",
  "/admin/campaigns/:campaignId/import-csv-file",
  "Import contacts from CSV file",
  "Imports a multipart CSV file into a campaign.",
  {
    params: campaignParams,
    body: object({ file: { type: "string", format: "binary", description: "UTF-8 .csv file" } }),
    consumes: ["multipart/form-data"],
    success: ref("ImportCsvResponse"),
    successStatus: 201,
    errors: [...adminErrors, 404, 413]
  }
);

add(
  "POST",
  "/admin/suppression",
  "Create suppression entry",
  "Normalizes and creates or updates a global suppression entry.",
  {
    body: ref("CreateSuppressionRequest"),
    success: object({ item: ref("SuppressionEntry") }),
    successStatus: 201,
    errors: adminErrors
  }
);
add(
  "GET",
  "/admin/suppression",
  "List suppression entries",
  "Returns searchable and paginated global suppression entries.",
  {
    querystring: object(
      {
        q: { type: "string", maxLength: 160, default: "", description: "Phone number or reason search" },
        ...pagination(25)
      },
      []
    ),
    success: ref("SuppressionListResponse"),
    errors: adminErrors
  }
);
add(
  "POST",
  "/admin/suppression/import-csv-file",
  "Import suppression CSV",
  "Imports phone numbers and optional reasons from a multipart CSV file.",
  {
    body: object({ file: { type: "string", format: "binary", description: "UTF-8 .csv file" } }),
    consumes: ["multipart/form-data"],
    success: ref("SuppressionImportResponse"),
    successStatus: 201,
    errors: [...adminErrors, 413]
  }
);
add(
  "DELETE",
  "/admin/suppression/:suppressionId",
  "Delete suppression entry",
  "Removes a suppression entry and records the removal event.",
  {
    params: params("suppressionId", "Suppression entry identifier"),
    success: ref("DeleteResponse"),
    errors: [...adminErrors, 404]
  }
);

export const manualOpenApiSchemas: JsonSchema[] = [
  {
    $id: "ErrorResponse",
    ...object(
      {
        message: { type: "string", description: "Human-readable error message" },
        issues: {
          type: "array",
          description: "Structured Zod validation issues, present for validation failures",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              code: { type: "string" },
              path: { type: "array", items: { type: ["string", "number"] } },
              message: { type: "string" }
            },
            required: ["code", "path", "message"]
          }
        }
      },
      ["message"]
    )
  },
  {
    $id: "RootServiceResponse",
    ...object({
      service: { type: "string", const: "outbound-dialer-api" },
      status: { type: "string", const: "ok" }
    })
  },
  {
    $id: "LiveHealthResponse",
    ...object({
      status: { type: "string", const: "ok" },
      service: { type: "string", const: "api" },
      uptimeSeconds: { type: "integer", minimum: 0 }
    })
  },
  {
    $id: "LoginResponse",
    ...object({
      token: { type: "string", description: "Bearer token for API clients" },
      user: ref("PublicUser")
    })
  },
  { $id: "CurrentUserResponse", ...object({ user: ref("PublicUser") }) },
  {
    $id: "CampaignSummary",
    ...object({
      id: uuid("Campaign identifier"),
      name: { type: "string" },
      status: ref("CampaignStatus"),
      loaded: { type: "integer", minimum: 0 },
      callable: { type: "integer", minimum: 0 },
      attempted: { type: "integer", minimum: 0 },
      outcomeDistribution: {
        type: "array",
        items: object({ outcome: { type: "string" }, count: { type: "integer", minimum: 0 } })
      },
      manualDialingEnabled: { type: "boolean" },
      callRecordingEnabled: { type: "boolean" },
      earlyMediaAvmdEnabled: { type: "boolean" }
    })
  },
  {
    $id: "RecordingSummary",
    ...object({
      id: uuid("Recording identifier"),
      name: { type: "string" },
      durationSeconds: { type: "number", minimum: 0 },
      fileSizeBytes: { type: "integer", minimum: 0 },
      status: { type: "string" }
    })
  },
  {
    $id: "SuppressionEntry",
    ...object({
      id: uuid("Suppression entry identifier"),
      phoneNumber: { type: "string" },
      reason: { type: "string" },
      createdAt: dateTime("Creation time")
    })
  }
];

export function getDocumentedRouteSchema(method: string | string[], url: string): DocumentedRouteSchema {
  const methods = Array.isArray(method) ? method : [method];
  const documentedMethod = methods.find((candidate) => candidate !== "HEAD") ?? methods[0];
  const schema = routes.get(`${documentedMethod.toUpperCase()} ${url}`);
  if (!schema) {
    throw new Error(`Missing detailed OpenAPI schema for ${documentedMethod.toUpperCase()} ${url}`);
  }
  return schema;
}

export const documentedRouteKeys = [...routes.keys()].sort();
