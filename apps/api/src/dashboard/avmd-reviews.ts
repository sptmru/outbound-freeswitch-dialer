import type { AvmdActualParty, CallAvmdReview } from "@outbound-dialer/shared";
import type pg from "pg";

type ReviewRow = {
  actual_party: AvmdActualParty;
  notes: string | null;
  reviewed_by_name: string;
  reviewed_at: Date;
  updated_at: Date;
};

export async function upsertCallAvmdReview(
  pool: pg.Pool,
  input: { callId: string; actualParty: AvmdActualParty; notes?: string; reviewerUserId: string }
): Promise<{ status: "ok"; review: CallAvmdReview } | { status: "not_found" | "not_eligible" }> {
  const call = await pool.query<{
    answered_at: Date | null;
    avmd_attempted: boolean;
    ended_at: Date | null;
    state: string;
  }>(
    `
      select
        answered_at,
        ended_at,
        state,
        exists (
          select 1 from call_events
          where call_events.call_id = calls.id
            and call_events.event_type = 'voicemail_detection_started'
        ) as avmd_attempted
      from calls
      where id = $1
    `,
    [input.callId]
  );
  const row = call.rows[0];
  if (!row) return { status: "not_found" };
  if (
    !row.avmd_attempted ||
    !row.answered_at ||
    !row.ended_at ||
    !["completed", "failed", "canceled"].includes(row.state)
  ) {
    return { status: "not_eligible" };
  }

  const notes = input.notes?.trim() || null;
  const result = await pool.query<ReviewRow>(
    `
      insert into call_avmd_reviews (
        call_id,
        actual_party,
        notes,
        reviewed_by_user_id,
        reviewed_by_name
      )
      values ($1, $2, $3, $4, (select name from users where id = $4))
      on conflict (call_id) do update
      set actual_party = excluded.actual_party,
          notes = excluded.notes,
          reviewed_by_user_id = excluded.reviewed_by_user_id,
          reviewed_by_name = excluded.reviewed_by_name,
          updated_at = now()
      returning actual_party, notes, reviewed_by_name, reviewed_at, updated_at
    `,
    [input.callId, input.actualParty, notes, input.reviewerUserId]
  );
  return { status: "ok", review: mapReview(result.rows[0]!) };
}

export function mapReview(row: ReviewRow): CallAvmdReview {
  return {
    actualParty: row.actual_party,
    notes: row.notes,
    reviewedByName: row.reviewed_by_name,
    reviewedAt: row.reviewed_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
