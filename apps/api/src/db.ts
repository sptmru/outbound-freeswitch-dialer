import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { AppConfig } from "./config.js";

const { Pool } = pg;

export function createPool(config: AppConfig): pg.Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000
  });
}

export async function checkPostgres(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ now: Date }>("select now()");
  return `connected at ${result.rows[0]?.now.toISOString() ?? "unknown"}`;
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  try {
    await client.query("select pg_advisory_lock(hashtext('outbound-dialer-schema-migrations'))");
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        checksum_sha256 text,
        applied_at timestamptz not null default now()
      )
    `);
    await client.query("alter table schema_migrations add column if not exists checksum_sha256 text");

    const migrationFiles = (await readdir(migrationsDir))
      .filter((filename) => /^\d{3}_.+\.sql$/.test(filename))
      .sort((left, right) => left.localeCompare(right));

    for (const filename of migrationFiles) {
      const sql = await readFile(join(migrationsDir, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await client.query<{ checksum_sha256: string | null }>(
        "select checksum_sha256 from schema_migrations where filename = $1",
        [filename]
      );
      if (applied.rowCount) {
        const storedChecksum = applied.rows[0]?.checksum_sha256;
        if (storedChecksum && storedChecksum !== checksum) {
          throw new Error(`Applied migration ${filename} has changed`);
        }
        if (!storedChecksum) {
          await client.query("update schema_migrations set checksum_sha256 = $2 where filename = $1", [
            filename,
            checksum
          ]);
        }
        continue;
      }

      if (/^\s*--\s*outbound-dialer:no-transaction\b/m.test(sql)) {
        // Operations such as CREATE INDEX CONCURRENTLY are forbidden inside a
        // transaction. They must be idempotent because the process can stop
        // after the operation succeeds but before its checksum row is stored.
        const statements = sql
          .split(/^\s*--\s*outbound-dialer:statement\s*$/m)
          .map((statement) => statement.trim())
          .filter(Boolean);
        for (const statement of statements) await client.query(statement);
        await client.query("insert into schema_migrations (filename, checksum_sha256) values ($1, $2)", [
          filename,
          checksum
        ]);
        continue;
      }

      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (filename, checksum_sha256) values ($1, $2)", [
          filename,
          checksum
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("select pg_advisory_unlock(hashtext('outbound-dialer-schema-migrations'))");
    } finally {
      client.release();
    }
  }
}
