import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AppConfig } from "./config.js";

const { Pool } = pg;

export function createPool(config: AppConfig): pg.Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 10
  });
}

export async function checkPostgres(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ now: Date }>("select now()");
  return `connected at ${result.rows[0]?.now.toISOString() ?? "unknown"}`;
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const migrationFiles = [
    "001_initial_schema.sql",
    "002_agent_sip_secret.sql",
    "003_csv_import_failures_and_contact_dedupe.sql",
    "004_recording_duration_seconds.sql",
    "005_recording_file_size_bytes.sql"
  ];

  for (const filename of migrationFiles) {
    const applied = await pool.query("select 1 from schema_migrations where filename = $1", [filename]);
    if (applied.rowCount) {
      continue;
    }

    const sql = await readFile(join(migrationsDir, filename), "utf8");
    await pool.query("begin");
    try {
      await pool.query(sql);
      await pool.query("insert into schema_migrations (filename) values ($1)", [basename(filename)]);
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  }
}
