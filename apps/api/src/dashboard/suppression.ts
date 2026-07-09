import type pg from "pg";

export async function findSuppression(
  pool: pg.Pool,
  normalizedNumber: string
): Promise<{ reason: string | null } | null> {
  const result = await pool.query<{ reason: string | null }>(
    "select reason from suppression_entries where normalized_phone_number = $1",
    [normalizedNumber]
  );
  return result.rows[0] ?? null;
}
