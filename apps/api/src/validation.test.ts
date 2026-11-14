import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { z, ZodError } from "zod";
import { loadConfig } from "./config.js";
import { __testing as schemas } from "./dashboard/routes.js";
import { validationErrorResponse } from "./validation.js";

test("Zod 4 migration preserves normalized env defaults, coercion and optional values", () => {
  const input = {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://fixture@localhost/fixture_test",
    JWT_SECRET: "fixture-only-jwt-key-at-least-32-characters",
    API_PORT: "3001",
    DEFAULT_PHONE_COUNTRY_CODE: "gb",
    SIP_TRUNK_PROXY: "",
    PCAP_CAPTURE_ENABLED: "false"
  };
  const config = loadConfig(input);
  assert.equal(config.API_PORT, 3001);
  assert.equal(config.DEFAULT_PHONE_COUNTRY_CODE, "GB");
  assert.equal(config.SIP_TRUNK_PROXY, undefined);
  assert.equal(config.FREESWITCH_ESL_ENABLED, true);
  assert.equal(config.PCAP_CAPTURE_ENABLED, false);
  assert.equal(config.ALERTMANAGER_SLACK_ENABLED, false);
  assert.equal(loadConfig({ ...input, DEFAULT_PHONE_COUNTRY_CODE: "" }).DEFAULT_PHONE_COUNTRY_CODE, "US");
  assert.throws(() => loadConfig({ ...input, API_PORT: "invalid" }), ZodError);
  assert.throws(() => loadConfig({ ...input, DEFAULT_PHONE_COUNTRY_CODE: "ZZ" }), ZodError);
});

test("Zod 4 migration preserves legacy UUID-shaped route IDs and absent request fields", () => {
  // Zod 3 accepted UUID-shaped persisted IDs without RFC variant/version checks.
  const legacyId = "11111111-1111-1111-1111-111111111111";
  assert.deepEqual(
    schemas.manualDialValidationSchema.parse({ phoneNumber: "14155550100", campaignId: legacyId }),
    {
      phoneNumber: "14155550100",
      campaignId: legacyId
    }
  );
  assert.deepEqual(schemas.manualDialValidationSchema.parse({ phoneNumber: "14155550100" }), {
    phoneNumber: "14155550100"
  });
  assert.throws(
    () => schemas.manualDialValidationSchema.parse({ phoneNumber: "14155550100", campaignId: "not-an-id" }),
    ZodError
  );
  const campaign = schemas.createCampaignSchema.parse({
    name: "Fixture",
    status: "active",
    manualDialingEnabled: false,
    callRecordingEnabled: false,
    earlyMediaAvmdEnabled: false
  });
  assert.equal(Object.hasOwn(campaign, "autoAdvanceToNextLeadEnabled"), false);
  assert.throws(() => schemas.dropVoicemailSchema.parse({ recordingId: legacyId }), ZodError);
});

test("Zod 4 migration keeps the API contact-field collection bounded", () => {
  const contact = {
    campaignId: "11111111-1111-4111-8111-111111111111",
    name: "Fixture",
    phoneNumber: "14155550100"
  };
  const field = { label: "Fixture", value: "Value" };
  assert.equal(
    schemas.createContactSchema.parse({ ...contact, fields: Array(20).fill(field) }).fields?.length,
    20
  );
  assert.throws(
    () => schemas.createContactSchema.parse({ ...contact, fields: Array(21).fill(field) }),
    ZodError
  );
});

test("Zod 4 validation returns HTTP 400 with the documented envelope and issue paths", async () => {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send(validationErrorResponse(error));
    return reply.send(error);
  });
  app.post("/fixture", async (request) => z.object({ email: z.email() }).parse(request.body));
  try {
    const response = await app.inject({ method: "POST", url: "/fixture", payload: { email: "invalid" } });
    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.equal(body.message, "Validation failed");
    assert.equal(body.issues.length, 1);
    assert.deepEqual(body.issues[0].path, ["email"]);
    assert.equal(typeof body.issues[0].code, "string");
    assert.equal(typeof body.issues[0].message, "string");
    assert.equal(Object.hasOwn(body.issues[0], "input"), false);
  } finally {
    await app.close();
  }
});
