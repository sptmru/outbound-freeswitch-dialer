import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type pg from "pg";
import { __testing, openCampaignRecordingExport } from "./campaign-recording-export.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const playableCallId = "22222222-2222-4222-8222-222222222222";

describe("campaign recording ZIP export", () => {
  it("streams canonical campaign recordings with safe names and a contextual manifest", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "outbound-dialer-recording-export-"));
    const filePath = join(storageDir, `${playableCallId}.wav`);
    await writeFile(filePath, Buffer.from("RIFF-playable-recording"));
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = createQueryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("from campaigns")) return rows([{ id: campaignId }]);
      assert.match(sql, /calls\.campaign_id = \$1/);
      assert.match(sql, /calls\.call_recording_status = 'available'/);
      assert.match(sql, /matched_contacts\.normalized_phone_number = calls\.normalized_destination_number/);
      assert.match(sql, /matched_contacts\.id = calls\.contact_id/);
      assert.match(sql, /matched_contacts\.campaign_id = calls\.campaign_id/);
      assert.match(sql, /order by calls\.created_at asc, calls\.id asc/);
      return rows([
        recordingRow({
          id: playableCallId,
          call_recording_path: filePath,
          lead_name: "=Spreadsheet formula"
        })
      ]);
    });

    try {
      const exported = await openCampaignRecordingExport(pool, campaignId, storageDir);
      assert.equal(exported.status, "ready");
      if (exported.status !== "ready") return;

      const chunks: Buffer[] = [];
      for await (const chunk of exported.stream) chunks.push(Buffer.from(chunk));
      const archive = Buffer.concat(chunks);

      assert.equal(archive.subarray(0, 4).toString("hex"), "504b0304");
      assert.match(archive.toString("latin1"), /manifest\.csv/);
      assert.match(archive.toString("latin1"), new RegExp(`${playableCallId}\\.wav`));
      assert.equal(exported.filename, `campaign-${campaignId}-recordings.zip`);
      assert.equal(exported.includedCount, 1);
      assert.equal(exported.skippedCount, 0);
      assert.deepEqual(
        queries.map((query) => query.params),
        [[campaignId], [campaignId]]
      );

      const included = {
        id: playableCallId,
        filePath,
        createdAt: new Date("2026-08-04T10:20:30.000Z"),
        destinationNumber: "+14155550100",
        leadName: "=Spreadsheet formula",
        outcome: "answered"
      };
      const skippedBase = {
        id: "33333333-3333-4333-8333-333333333333",
        createdAt: included.createdAt,
        destinationNumber: "+14155550101",
        leadName: "Skipped lead",
        outcome: null
      };
      const manifest = __testing.recordingManifest(
        [included],
        [
          { ...skippedBase, reason: "missing" },
          { ...skippedBase, id: "44444444-4444-4444-8444-444444444444", reason: "empty" },
          { ...skippedBase, id: "55555555-5555-4555-8555-555555555555", reason: "unsafe_path" },
          { ...skippedBase, id: "66666666-6666-4666-8666-666666666666", reason: "not_regular" }
        ]
      );
      assert.match(manifest, /"'=Spreadsheet formula"/);
      assert.match(manifest, new RegExp(`"${playableCallId}\\.wav"`));
      assert.match(manifest, /"skipped","missing"/);
      assert.match(manifest, /"skipped","empty"/);
      assert.match(manifest, /"skipped","unsafe_path"/);
      assert.match(manifest, /"skipped","not_regular"/);
    } finally {
      await rm(storageDir, { force: true, recursive: true });
    }
  });

  it("skips missing, empty, and non-canonical files and reports an empty export", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "outbound-dialer-recording-export-"));
    const emptyCallId = "33333333-3333-4333-8333-333333333333";
    const missingCallId = "44444444-4444-4444-8444-444444444444";
    const mismatchedCallId = "55555555-5555-4555-8555-555555555555";
    await writeFile(join(storageDir, `${emptyCallId}.wav`), Buffer.alloc(0));
    const outsidePath = join(storageDir, "not-the-call-id.wav");
    await writeFile(outsidePath, Buffer.from("must not be exported"));
    const pool = createQueryPool((sql) => {
      if (sql.includes("from campaigns")) return rows([{ id: campaignId }]);
      return rows([
        recordingRow({ id: emptyCallId, call_recording_path: join(storageDir, `${emptyCallId}.wav`) }),
        recordingRow({ id: missingCallId, call_recording_path: join(storageDir, `${missingCallId}.wav`) }),
        recordingRow({ id: mismatchedCallId, call_recording_path: outsidePath })
      ]);
    });

    try {
      assert.deepEqual(await openCampaignRecordingExport(pool, campaignId, storageDir), {
        status: "no_recordings"
      });
    } finally {
      await rm(storageDir, { force: true, recursive: true });
    }
  });

  it("returns campaign_not_found without querying or streaming recording paths", async () => {
    let queryCount = 0;
    const pool = createQueryPool((sql, params) => {
      queryCount += 1;
      assert.match(sql, /from campaigns/);
      assert.deepEqual(params, [campaignId]);
      return rows([]);
    });

    assert.deepEqual(await openCampaignRecordingExport(pool, campaignId, "/recordings"), {
      status: "campaign_not_found"
    });
    assert.equal(queryCount, 1);
  });
});

function recordingRow(
  overrides: Partial<{
    id: string;
    call_recording_path: string;
    created_at: Date;
    destination_number: string;
    lead_name: string | null;
    outcome: string | null;
  }> = {}
) {
  return {
    id: playableCallId,
    call_recording_path: `/recordings/${playableCallId}.wav`,
    created_at: new Date("2026-08-04T10:20:30.000Z"),
    destination_number: "+14155550100",
    lead_name: "Avery Johnson",
    outcome: "answered",
    ...overrides
  };
}

function createQueryPool(
  handler: (sql: string, params: readonly unknown[]) => { rows: unknown[]; rowCount: number }
): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

function rows<T>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}
