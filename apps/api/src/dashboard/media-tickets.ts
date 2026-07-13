import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

export type MediaResourceType = "call_recording" | "voicemail_recording";

export async function createMediaTicket(
  pool: pg.Pool,
  input: { userId: string; resourceType: MediaResourceType; resourceId: string; lifetimeSeconds?: number }
): Promise<{ ticket: string; expiresAt: Date }> {
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (input.lifetimeSeconds ?? 60) * 1000);

  await pool.query("delete from media_access_tickets where expires_at <= now()");
  await pool.query(
    `
      insert into media_access_tickets (token_hash, user_id, resource_type, resource_id, expires_at)
      values ($1, $2, $3, $4, $5)
    `,
    [hashTicket(ticket), input.userId, input.resourceType, input.resourceId, expiresAt]
  );

  return { ticket, expiresAt };
}

export async function verifyMediaTicket(
  pool: pg.Pool,
  input: {
    ticket: string;
    resourceType: MediaResourceType;
    resourceId: string;
    idleLifetimeSeconds?: number;
    absoluteLifetimeSeconds?: number;
  }
): Promise<boolean> {
  const result = await pool.query(
    `
      update media_access_tickets
      set expires_at = least(
        media_access_tickets.created_at + make_interval(secs => $4),
        now() + make_interval(secs => $5)
      )
      from users
      where users.id = media_access_tickets.user_id
        and media_access_tickets.token_hash = $1
        and media_access_tickets.resource_type = $2
        and media_access_tickets.resource_id = $3
        and media_access_tickets.expires_at > now()
        and media_access_tickets.created_at + make_interval(secs => $4) > now()
        and users.is_active = true
        and users.role = 'admin'
      returning 1
    `,
    [
      hashTicket(input.ticket),
      input.resourceType,
      input.resourceId,
      input.absoluteLifetimeSeconds ?? 14_400,
      input.idleLifetimeSeconds ?? 60
    ]
  );
  return Boolean(result.rowCount);
}

export function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}
