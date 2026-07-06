import "dotenv/config";
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
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_SECONDS: z.coerce.number().int().positive().default(86400),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().default("Admin"),
  SIP_USERNAME_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("agent")
});

export type AppConfig = z.infer<typeof envSchema> & {
  corsOrigins: string[];
};

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  };
}
