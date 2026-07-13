import "dotenv/config";
import { isSupportedCountry } from "libphonenumber-js";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  FREESWITCH_ESL_HOST: z.string().default("freeswitch"),
  FREESWITCH_ESL_PORT: z.coerce.number().int().positive().default(8021),
  FREESWITCH_ESL_PASSWORD: z.string().default("ClueCon"),
  FREESWITCH_ESL_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  FREESWITCH_ESL_EVENT_QUEUE_MAX_SIZE: z.coerce.number().int().min(10).max(100_000).default(1_000),
  FREESWITCH_ESL_EVENT_RETRY_INITIAL_MS: z.coerce.number().int().min(10).max(60_000).default(250),
  FREESWITCH_ESL_EVENT_RETRY_MAX_MS: z.coerce.number().int().min(100).max(300_000).default(30_000),
  FREESWITCH_ESL_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_SECONDS: z.coerce.number().int().positive().max(86400).default(28800),
  SIP_SECRET_ENCRYPTION_KEY: z.string().min(32).optional(),
  SIP_SECRET_WRITE_VERSION: z.enum(["v1", "v2"]).default("v1"),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  CONTACT_MAX_ATTEMPTS: z.coerce.number().int().positive().max(100).default(3),
  CONTACT_RETRY_DELAY_SECONDS: z.coerce.number().int().nonnegative().max(604800).default(900),
  AGENT_WRAP_UP_SECONDS: z.coerce.number().int().nonnegative().max(3600).default(30),
  ORIGINATE_AGENT_WATCHDOG_SECONDS: z.coerce.number().int().min(30).max(120).default(35),
  ORIGINATE_CUSTOMER_WATCHDOG_SECONDS: z.coerce.number().int().min(45).max(180).default(50),
  ORIGINATE_WATCHDOG_RETRY_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
  ORIGINATE_WATCHDOG_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  CALL_HISTORY_EXPORT_MAX_ROWS: z.coerce.number().int().min(100).max(250000).default(50000),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().default("Admin"),
  DEFAULT_PHONE_COUNTRY_CODE: z
    .string()
    .length(2)
    .transform((value) => value.toUpperCase())
    .refine((value) => isSupportedCountry(value), "Unsupported default phone country code")
    .default("US"),
  SIP_USERNAME_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("agent"),
  FREESWITCH_GENERATED_CONFIG_DIR: z.string().default("/var/lib/outbound-dialer/freeswitch"),
  VOICEMAIL_RECORDINGS_STORAGE_DIR: z.string().default("/var/lib/freeswitch/storage/recordings"),
  VOICEMAIL_UPLOAD_MAX_BYTES: z.coerce.number().int().min(1_000_000).max(268_435_456).default(67_108_864),
  VOICEMAIL_DROP_START_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(900).default(120),
  CALL_RECORDINGS_STORAGE_DIR: z.string().default("/var/lib/freeswitch/storage/recordings/calls"),
  CALL_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
  CALL_RECORDING_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RETENTION_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  RETENTION_RUN_INTERVAL_SECONDS: z.coerce.number().int().min(3600).default(86400),
  MEDIA_TICKET_TTL_SECONDS: z.coerce.number().int().positive().max(300).default(60),
  MEDIA_TICKET_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(300).max(86400).default(14400),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  FREESWITCH_DOMAIN: z.string().default("localhost"),
  FREESWITCH_WEBRTC_WSS_PORT: z.coerce.number().int().positive().default(7443),
  FREESWITCH_WEBRTC_PUBLIC_WS_URL: z.string().url().optional(),
  MONITORING_STUCK_CALL_SECONDS: z.coerce.number().int().positive().default(900),
  SIP_TRUNK_MODE: z.enum(["registration", "ip_auth"]).default("registration"),
  SIP_TRUNK_PROXY: z.string().optional(),
  SIP_TRUNK_USERNAME: z.string().optional(),
  SIP_TRUNK_CALLER_ID: z.string().optional()
});

export type AppConfig = z.infer<typeof envSchema> & {
  corsOrigins: string[];
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(normalizeEnv(process.env));
  assertProductionConfiguration(parsed);

  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  };
}

function assertProductionConfiguration(config: z.infer<typeof envSchema>): void {
  if (config.NODE_ENV !== "production") {
    return;
  }

  const problems: string[] = [];
  requireProductionSecret(problems, "JWT_SECRET", config.JWT_SECRET);
  requireProductionSecret(problems, "FREESWITCH_ESL_PASSWORD", config.FREESWITCH_ESL_PASSWORD);
  requireProductionSecret(problems, "SIP_SECRET_ENCRYPTION_KEY", config.SIP_SECRET_ENCRYPTION_KEY);

  if (config.BOOTSTRAP_ADMIN_EMAIL) {
    requireProductionSecret(problems, "BOOTSTRAP_ADMIN_PASSWORD", config.BOOTSTRAP_ADMIN_PASSWORD);
  }
  if (/change-me|example-password|password-not-configured/i.test(config.DATABASE_URL)) {
    problems.push("DATABASE_URL contains a placeholder password");
  }
  if (config.JWT_EXPIRES_SECONDS > 28800) {
    problems.push("JWT_EXPIRES_SECONDS must not exceed 28800 in production");
  }

  if (problems.length) {
    throw new Error(`Unsafe production configuration:\n- ${problems.join("\n- ")}`);
  }
}

function requireProductionSecret(problems: string[], name: string, value: string | undefined): void {
  if (!value || value.length < 32 || /change-me|cluecon|example|not-configured/i.test(value)) {
    problems.push(`${name} must be a non-default secret with at least 32 characters`);
  }
}

function normalizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const legacyPrefix = ["MA", "XO"].join("");
  const normalized: NodeJS.ProcessEnv = {
    ...env,
    SIP_TRUNK_MODE: env.SIP_TRUNK_MODE || env[`${legacyPrefix}_TRUNK_MODE`],
    SIP_TRUNK_PROXY: env.SIP_TRUNK_PROXY || env[`${legacyPrefix}_SIP_PROXY`],
    SIP_TRUNK_USERNAME: env.SIP_TRUNK_USERNAME || env[`${legacyPrefix}_USERNAME`],
    SIP_TRUNK_CALLER_ID: env.SIP_TRUNK_CALLER_ID || env[`${legacyPrefix}_CALLER_ID`]
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (value === "") {
      delete normalized[key];
    }
  }
  return normalized;
}
