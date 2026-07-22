import type pg from "pg";

const USER_MEDIA_ADVISORY_LOCK_NAMESPACE = 72_201;

export async function lockUserMediaAction(client: pg.PoolClient, userId: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock($1, hashtext($2))", [
    USER_MEDIA_ADVISORY_LOCK_NAMESPACE,
    userId
  ]);
}

export async function lockUserMediaSession(client: pg.PoolClient, userId: string): Promise<void> {
  await client.query("select pg_advisory_lock($1, hashtext($2))", [
    USER_MEDIA_ADVISORY_LOCK_NAMESPACE,
    userId
  ]);
}

export async function unlockUserMediaSession(client: pg.PoolClient, userId: string): Promise<void> {
  const result = await client.query<{ unlocked: boolean }>(
    "select pg_advisory_unlock($1, hashtext($2)) as unlocked",
    [USER_MEDIA_ADVISORY_LOCK_NAMESPACE, userId]
  );
  if (!result.rows[0]?.unlocked) {
    throw new Error("PostgreSQL did not release the user media advisory lock");
  }
}
