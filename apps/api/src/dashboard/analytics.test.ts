import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { __testing, getAdminAnalytics, parseAnalyticsFilters } from "./analytics.js";

const campaignId = "11111111-1111-4111-8111-111111111111";

describe("admin analytics", () => {
  it("defaults to seven inclusive UTC calendar dates and preserves an optional campaign filter", () => {
    const now = new Date("2026-07-15T08:30:00.000Z");
    const filters = parseAnalyticsFilters({ campaignId, timeZone: "Asia/Yerevan" }, now);

    assert.equal(filters.to.toISOString(), "2026-07-15T08:30:00.000Z");
    assert.equal(filters.from.toISOString(), "2026-07-09T00:00:00.000Z");
    assert.equal(filters.campaignId, campaignId);
    assert.equal(filters.timeZone, "Asia/Yerevan");
  });

  it("defaults the analytics time zone to UTC and rejects unsupported zones", () => {
    assert.equal(parseAnalyticsFilters({}).timeZone, "UTC");
    assert.throws(() => parseAnalyticsFilters({ timeZone: "Mars/Olympus_Mons" }), /supported IANA time zone/);
  });

  it("requires ISO datetimes in order and caps the range at 366 days", () => {
    assert.throws(() => parseAnalyticsFilters({ from: "yesterday" }));
    assert.throws(
      () =>
        parseAnalyticsFilters({
          from: "2026-07-16T00:00:00.000Z",
          to: "2026-07-15T00:00:00.000Z"
        }),
      /from must be before or equal to to/
    );
    assert.throws(
      () =>
        parseAnalyticsFilters({
          from: "2025-07-14T00:00:00.000Z",
          to: "2026-07-15T00:00:00.001Z"
        }),
      /cannot exceed 366 days/
    );
  });

  it("uses bound filters and maps counts, percentages, snapshots, and retry efficiency", async () => {
    const from = new Date("2026-07-08T00:00:00.000Z");
    const to = new Date("2026-07-15T00:00:00.000Z");
    const snapshotAt = new Date("2026-07-15T00:01:00.000Z");
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql === __testing.overviewSql) {
          return rows([
            {
              attempts: "10",
              unique_contacts: "8",
              answered: "6",
              connected: "4",
              average_talk_seconds: "31.6",
              failed: "2",
              voicemail_requested: "3",
              voicemail_started: "3",
              agent_released: "2",
              voicemail_completed: "2",
              voicemail_failed_or_interrupted: "1",
              average_release_seconds: "1.6",
              completed: "3"
            }
          ]);
        }
        if (sql === __testing.dailySql) {
          return rows([
            {
              date: "2026-07-08",
              attempts: "10",
              answered: "6",
              connected: "4",
              failed: "2",
              voicemail_completed: "2",
              average_talk_seconds: "31.6"
            }
          ]);
        }
        if (sql === __testing.campaignSql) {
          return rows([
            {
              id: campaignId,
              name: "Renewals",
              status: "active",
              loaded: "20",
              callable: "7",
              attempted_contacts: "8",
              attempts: "10",
              answered: "6",
              connected: "4",
              average_talk_seconds: "31.6",
              repeated_contacts: "3",
              connected_repeated_contacts: "2",
              voicemail_completed: "2"
            }
          ]);
        }
        if (sql === __testing.agentSql) {
          return rows([
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Alex",
              is_active: true,
              registered: true,
              availability_status: "available",
              active_call: false,
              attempts: "10",
              answered: "6",
              connected: "4",
              average_talk_seconds: "31.6",
              voicemail_drops: "2",
              failed: "2"
            }
          ]);
        }
        if (sql === __testing.dataQualitySql) {
          return rows([
            {
              total_contacts: "20",
              callable: "7",
              suppressed: "3",
              exhausted: "4",
              imported_rows: "18",
              rejected_rows: "5",
              duplicate_rows: "2"
            }
          ]);
        }
        if (sql === __testing.avmdQualitySql) {
          return rows([
            {
              eligible_calls: "10",
              reviewed_calls: "6",
              uncertain_reviews: "1",
              true_positives: "2",
              false_positives: "1",
              true_negatives: "2",
              false_negatives: "0"
            }
          ]);
        }
        if (sql === __testing.mediaOverviewSql) {
          return rows([
            {
              answered_calls: "6",
              observed_calls: "4",
              suspected_one_way_calls: "1",
              average_mos: "4.12",
              p95_jitter_loss_rate: "0.37",
              average_quality_percentage: "91.24",
              providers: [{ provider: "sip-trunk", count: 4 }]
            }
          ]);
        }
        if (sql === __testing.mediaLegsSql) {
          return rows([
            {
              leg_type: "customer",
              observed_calls: "4",
              average_mos: "4.12",
              p95_jitter_loss_rate: "0.37",
              average_quality_percentage: "91.24",
              codecs: [{ codec: "PCMU", count: 4 }]
            }
          ]);
        }
        if (sql === __testing.browserMediaSql) {
          return rows([
            {
              answered_calls: "6",
              observed_calls: "3",
              average_inbound_loss_rate: "0.24",
              average_concealed_sample_rate: "0.11",
              average_jitter_buffer_ms: "22.4",
              p95_jitter_ms: "31.8",
              p95_round_trip_time_ms: "104.6",
              paths: [{ path: "host -> host", count: 3 }]
            }
          ]);
        }
        if (sql === __testing.telephonyReliabilitySql) {
          return rows([
            {
              finalization_samples: "5",
              average_finalization_ms: "42.4",
              p95_finalization_ms: "88.7",
              max_finalization_ms: "91",
              registration_db_count: 2,
              registration_freeswitch_count: 2,
              registration_drift_count: 0,
              registration_corrections_last_run: 1,
              registration_reconciled_at: new Date("2026-07-15T00:00:30.000Z"),
              active_calls_db_count: 1,
              active_calls_missing_in_freeswitch: 0,
              active_calls_closed_last_run: 0,
              active_calls_reconciled_at: new Date("2026-07-15T00:00:40.000Z"),
              reconciliation_closures: "1"
            }
          ]);
        }
        throw new Error("Unexpected analytics query");
      }
    } as unknown as pg.Pool;

    const result = await getAdminAnalytics(
      pool,
      { from, to, campaignId, timeZone: "Asia/Yerevan" },
      { maxAttempts: 3, retryDelaySeconds: 60 },
      snapshotAt
    );

    assert.equal(queries.length, 10);
    assert.deepEqual(
      queries.map((query) => query.params),
      [
        [from, to, campaignId],
        [from, to, campaignId, "Asia/Yerevan"],
        [from, to, campaignId, 3, 60, snapshotAt],
        [from, to, campaignId],
        [from, to, campaignId, 3, 60, snapshotAt],
        [from, to, campaignId],
        [from, to, campaignId],
        [from, to, campaignId],
        [from, to, campaignId],
        [from, to, campaignId]
      ]
    );
    assert.deepEqual(result.summary, {
      attempts: 10,
      uniqueContacts: 8,
      answered: 6,
      answerRate: 60,
      connected: 4,
      contactRate: 40,
      averageTalkSeconds: 32,
      failed: 2,
      voicemailCompleted: 2,
      voicemailCompletionRate: 66.7
    });
    assert.equal(result.filters.timeZone, "Asia/Yerevan");
    assert.match(__testing.dailySql, /at time zone \$4::text/);
    assert.deepEqual(result.funnel, [
      { stage: "Attempts", count: 10 },
      { stage: "Answered", count: 6 },
      { stage: "Connected", count: 4 },
      { stage: "Completed", count: 3 }
    ]);
    for (let index = 1; index < result.funnel.length; index += 1) {
      assert.ok(result.funnel[index - 1]!.count >= result.funnel[index]!.count);
    }
    assert.equal(result.campaignPerformance[0]?.contactRate, 40);
    assert.equal(result.campaignPerformance[0]?.retryEfficiency, 66.7);
    assert.equal(result.agentPerformance[0]?.connected, 4);
    assert.equal(result.agentPerformance[0]?.isActive, true);
    assert.deepEqual(result.dataQuality, {
      snapshotAt: "2026-07-15T00:01:00.000Z",
      totalContacts: 20,
      callable: 7,
      suppressed: 3,
      exhausted: 4,
      importedRows: 18,
      rejectedRows: 5,
      duplicateRows: 2,
      invalidRows: 3
    });
    assert.equal(result.voicemail.completionRate, 66.7);
    assert.equal(result.voicemail.averageReleaseSeconds, 2);
    assert.deepEqual(result.avmdQuality, {
      eligibleCalls: 10,
      reviewedCalls: 6,
      uncertainReviews: 1,
      reviewCoverageRate: 60,
      truePositives: 2,
      falsePositives: 1,
      trueNegatives: 2,
      falseNegatives: 0,
      precision: 66.7,
      recall: 100,
      falsePositiveRate: 33.3
    });
    assert.equal(result.mediaQuality.coverageRate, 66.7);
    assert.equal(result.mediaQuality.averageMos, 4.1);
    assert.equal(result.mediaQuality.providers[0]?.provider, "sip-trunk");
    assert.equal(result.mediaQuality.legs[0]?.codecs[0]?.codec, "PCMU");
    assert.equal(result.mediaQuality.browser.coverageRate, 50);
    assert.equal(result.mediaQuality.browser.averageJitterBufferMs, 22.4);
    assert.equal(result.mediaQuality.browser.paths[0]?.path, "host -> host");
    assert.match(__testing.mediaOverviewSql, /duration_seconds >= 10/);
    assert.match(
      __testing.mediaOverviewSql,
      /coalesce\(inbound_media_packet_count, inbound_packet_count\) <= 5/
    );
    assert.equal(result.telephonyReliability.p95FinalizationMs, 88.7);
    assert.equal(result.telephonyReliability.reconciliationClosures, 1);
  });

  it("returns zero percentages when there is no denominator", () => {
    assert.equal(__testing.percent(3, 0), 0);
    assert.equal(__testing.percent(0, 0), 0);
    assert.equal(__testing.nullablePercent(0, 0), null);
  });
});

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
