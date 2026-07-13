import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { runCallRecordingFinalization } from "./call-recording-finalizer.js";

const callId = "11111111-1111-4111-8111-111111111111";
const recordingPath = `/var/lib/freeswitch/storage/recordings/calls/${callId}.wav`;
const claimToken = "2026-07-13 12:00:00.123456+00";

describe("call recording finalization", () => {
  it("claims a terminal recording, verifies it, persists metadata, and emits a finalization event", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = queryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("unavailable as")) {
        return rows([]);
      }
      if (sql.includes("with candidates")) {
        return rows([{ id: callId, call_recording_path: recordingPath, claim_token: claimToken }]);
      }
      assert.match(sql, /call_recording_status = 'available'/);
      assert.match(sql, /'call_recording_finalized'/);
      return result([{ call_id: callId }], 1);
    });

    const finalized = await runCallRecordingFinalization(pool, "ffprobe-test", {
      inspect: async (path, ffprobePath) => {
        assert.equal(path, recordingPath);
        assert.equal(ffprobePath, "ffprobe-test");
        return { durationSeconds: 42, fileSizeBytes: 12_345 };
      }
    });

    assert.deepEqual(finalized, { claimed: 1, available: 1, failed: 0, skipped: 0 });
    assert.deepEqual(queries[1]?.params, [5, 300, 10]);
    assert.match(queries[1]?.sql ?? "", /for update skip locked/);
    assert.match(queries[1]?.sql ?? "", /call_recording_status = 'finalizing'/);
    assert.deepEqual(queries[2]?.params.slice(0, 4), [callId, claimToken, 42, 12_345]);
  });

  it("marks an unreadable recording failed and emits an integrity failure event", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = queryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("unavailable as")) {
        return rows([]);
      }
      if (sql.includes("with candidates")) {
        return rows([{ id: callId, call_recording_path: recordingPath, claim_token: claimToken }]);
      }
      assert.match(sql, /call_recording_status = 'failed'/);
      assert.match(sql, /'call_recording_integrity_failed'/);
      return result([{ call_id: callId }], 1);
    });

    const finalized = await runCallRecordingFinalization(pool, "ffprobe", {
      inspect: async () => {
        throw new Error("corrupt wave file");
      }
    });

    assert.deepEqual(finalized, { claimed: 1, available: 0, failed: 1, skipped: 0 });
    assert.equal(queries[2]?.params[2], "corrupt wave file");
    assert.match(String(queries[2]?.params[3]), /corrupt wave file/);
  });

  it("recovers stale finalizing claims and ignores a claim superseded by another worker", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = queryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("unavailable as")) {
        return rows([]);
      }
      if (sql.includes("with candidates")) {
        return rows([{ id: callId, call_recording_path: recordingPath, claim_token: claimToken }]);
      }
      return result([], 0);
    });

    const finalized = await runCallRecordingFinalization(pool, "ffprobe", {
      inspect: async () => ({ durationSeconds: 1, fileSizeBytes: 44 })
    });

    assert.match(queries[1]?.sql ?? "", /call_recording_status = 'finalizing'/);
    assert.match(queries[1]?.sql ?? "", /coalesce\(call_recording_integrity_checked_at, ended_at\)/);
    assert.match(queries[2]?.sql ?? "", /call_recording_integrity_checked_at = \$2::timestamptz/);
    assert.deepEqual(finalized, { claimed: 1, available: 0, failed: 0, skipped: 1 });
  });

  it("does nothing when no terminal recordings are ready", async () => {
    const pool = queryPool(() => rows([]));
    let inspections = 0;

    const finalized = await runCallRecordingFinalization(pool, "ffprobe", {
      inspect: async () => {
        inspections += 1;
        return { durationSeconds: 1, fileSizeBytes: 1 };
      }
    });

    assert.equal(inspections, 0);
    assert.deepEqual(finalized, { claimed: 0, available: 0, failed: 0, skipped: 0 });
  });

  it("fails terminal enabled calls that never started a recording file", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = queryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("unavailable as")) {
        return result([{ call_id: callId }], 1);
      }
      return rows([]);
    });

    const finalized = await runCallRecordingFinalization(pool, "ffprobe", {
      inspect: async () => {
        throw new Error("should not inspect a missing path");
      }
    });

    assert.match(queries[0]?.sql ?? "", /call_recording_status = 'pending'/);
    assert.match(queries[0]?.sql ?? "", /call_recording_path is null/);
    assert.match(queries[0]?.sql ?? "", /'call_recording_integrity_failed'/);
    assert.deepEqual(finalized, { claimed: 1, available: 0, failed: 1, skipped: 0 });
  });
});

function queryPool(handler: (sql: string, params: readonly unknown[]) => QueryResult): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

type QueryResult = { rows: any[]; rowCount: number };

function rows<T>(items: T[]): QueryResult {
  return result(items, items.length);
}

function result<T>(items: T[], rowCount: number): QueryResult {
  return { rows: items, rowCount };
}
