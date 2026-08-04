import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { getCallDetail, getCallHistoryPage } from "./responders.js";

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}

describe("call-history lead names", () => {
  it("uses normalized-number lead matches in history search and preserves the manual fallback", async () => {
    const createdAt = new Date("2026-08-04T08:00:00.000Z");
    let historySql = "";
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        historySql = sql;
        assert.equal(params[0], "known lead");
        return rows([
          {
            id: "11111111-1111-4111-8111-111111111111",
            lead_name: "Known lead",
            agent_name: "Alex",
            phone_number: "+14155550100",
            campaign_name: "Follow-up",
            campaign_id: "22222222-2222-4222-8222-222222222222",
            agent_user_id: "33333333-3333-4333-8333-333333333333",
            state: "completed",
            outcome: "answered",
            created_at: createdAt,
            created_at_cursor: "2026-08-04T08:00:00.000000Z",
            duration_seconds: 30,
            recording_available: true,
            pcap_status: null,
            pcap_available: false,
            voicemail_signal_status: null,
            avmd_review_status: null,
            total_count: "2"
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            lead_name: null,
            agent_name: "Alex",
            phone_number: "+14155550101",
            campaign_name: "Follow-up",
            campaign_id: "22222222-2222-4222-8222-222222222222",
            agent_user_id: "33333333-3333-4333-8333-333333333333",
            state: "completed",
            outcome: "answered",
            created_at: createdAt,
            created_at_cursor: "2026-08-04T08:00:00.000000Z",
            duration_seconds: 20,
            recording_available: false,
            pcap_status: null,
            pcap_available: false,
            voicemail_signal_status: null,
            avmd_review_status: null,
            total_count: "2"
          }
        ]);
      }
    } as unknown as pg.Pool;

    const page = await getCallHistoryPage(pool, {
      page: 1,
      pageSize: 25,
      q: " known lead "
    });

    assert.deepEqual(
      page.items.map((item) => item.leadName),
      ["Known lead", "Manual dial"]
    );
    assert.match(
      historySql,
      /matched_contacts\.normalized_phone_number = calls\.normalized_destination_number/
    );
    assert.match(
      historySql,
      /coalesce\(matched_contacts\.id = calls\.contact_id, false\) desc,[\s\S]*coalesce\(matched_contacts\.campaign_id = calls\.campaign_id, false\) desc,[\s\S]*matched_contacts\.created_at desc,[\s\S]*matched_contacts\.id desc/
    );
    assert.match(historySql, /concat_ws\(' ', resolved_contact\.display_name,/);
  });

  it("uses the same normalized-number name resolution for call detail", async () => {
    let detailSql = "";
    const pool = {
      query: async (sql: string) => {
        detailSql = sql;
        return rows([]);
      }
    } as unknown as pg.Pool;

    const detail = await getCallDetail(pool, "55555555-5555-4555-8555-555555555555");

    assert.equal(detail, null);
    assert.match(detailSql, /resolved_contact\.display_name as lead_name/);
    assert.match(
      detailSql,
      /matched_contacts\.normalized_phone_number = calls\.normalized_destination_number/
    );
  });
});
