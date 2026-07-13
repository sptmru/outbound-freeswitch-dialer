import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { runRetention } from "./retention.js";
import { runRetentionWithAdvisoryLock } from "./retention-scheduler.js";

describe("retention", () => {
  it("does not count a call for deletion while its recording is still inside the longer retention window", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = queryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("select id, call_recording_path")) {
        return rows([]);
      }
      if (sql.includes("select call_id, file_path")) {
        return rows([]);
      }
      return rows([{ count: "4" }]);
    });

    const result = await runRetention(pool, {
      dryRun: true,
      callRetentionDays: 7,
      recordingRetentionDays: 30,
      pcapRetentionDays: 7
    });

    assert.equal(result.calls, 4);
    const countQuery = queries[2];
    assert.match(countQuery.sql, /call_recording_path is null/);
    assert.match(countQuery.sql, /\$2::text/);
    assert.deepEqual(countQuery.params, [7, 30, 7]);
  });

  it("clears recording metadata only for files that were actually unlinked", async () => {
    const successfulId = "11111111-1111-4111-8111-111111111111";
    const failedId = "22222222-2222-4222-8222-222222222222";
    const clientQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const failures: string[] = [];
    const pool = transactionalPool(
      (sql) =>
        sql.includes("from call_pcaps")
          ? rows([])
          : rows([
              { id: successfulId, call_recording_path: "/recordings/success.wav" },
              { id: failedId, call_recording_path: "/recordings/failure.wav" }
            ]),
      (sql, params) => {
        clientQueries.push({ sql, params });
        return sql.includes("delete from calls") ? result([], 1) : rows([]);
      }
    );

    const retention = await runRetention(
      pool,
      { dryRun: false, callRetentionDays: 7, recordingRetentionDays: 30, pcapRetentionDays: 7 },
      {
        unlinkFile: async (path) => {
          if (path.includes("failure")) throw new Error("disk unavailable");
        },
        onUnlinkError: (_error, recording) => failures.push(recording.id)
      }
    );

    const metadataUpdate = clientQueries.find((query) => query.sql.includes("update calls"));
    assert.deepEqual(metadataUpdate?.params, [[successfulId]]);
    assert.match(metadataUpdate?.sql ?? "", /call_recording_status = 'expired'/);
    assert.deepEqual(failures, [failedId]);
    assert.match(
      clientQueries.find((query) => query.sql.includes("delete from calls"))?.sql ?? "",
      /call_recording_path is null/
    );
    assert.equal(retention.recordingFiles, 1);
    assert.equal(retention.calls, 1);
  });

  it("does not clear any recording metadata when every unlink fails", async () => {
    const clientQueries: string[] = [];
    const pool = transactionalPool(
      (sql) =>
        sql.includes("from call_pcaps")
          ? rows([])
          : rows([
              {
                id: "11111111-1111-4111-8111-111111111111",
                call_recording_path: "/recordings/failure.wav"
              }
            ]),
      (sql) => {
        clientQueries.push(sql);
        return rows([]);
      }
    );

    const retention = await runRetention(
      pool,
      { dryRun: false, callRetentionDays: 7, recordingRetentionDays: 30, pcapRetentionDays: 7 },
      {
        unlinkFile: async () => {
          throw new Error("permission denied");
        }
      }
    );

    assert.equal(
      clientQueries.some((sql) => sql.includes("update calls")),
      false
    );
    assert.equal(retention.recordingFiles, 0);
  });

  it("clears stale metadata when a retained recording is already absent", async () => {
    const recordingId = "11111111-1111-4111-8111-111111111111";
    const clientQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = transactionalPool(
      (sql) =>
        sql.includes("from call_pcaps")
          ? rows([])
          : rows([{ id: recordingId, call_recording_path: "/recordings/missing.wav" }]),
      (sql, params) => {
        clientQueries.push({ sql, params });
        return rows([]);
      }
    );
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });

    const retention = await runRetention(
      pool,
      { dryRun: false, callRetentionDays: 7, recordingRetentionDays: 30, pcapRetentionDays: 7 },
      {
        unlinkFile: async () => {
          throw missing;
        }
      }
    );

    assert.deepEqual(clientQueries.find((query) => query.sql.includes("update calls"))?.params, [
      [recordingId]
    ]);
    assert.equal(retention.recordingFiles, 1);
  });

  it("expires PCAP metadata only after the capture file is removed", async () => {
    const captureCallId = "33333333-3333-4333-8333-333333333333";
    const clientQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = transactionalPool(
      (sql) =>
        sql.includes("select call_id, file_path")
          ? rows([{ call_id: captureCallId, file_path: "/pcaps/call.pcap" }])
          : rows([]),
      (sql, params) => {
        clientQueries.push({ sql, params });
        return rows([]);
      }
    );

    const retention = await runRetention(
      pool,
      { dryRun: false, callRetentionDays: 7, recordingRetentionDays: 30, pcapRetentionDays: 7 },
      { unlinkFile: async () => undefined }
    );

    const metadataUpdate = clientQueries.find((query) => query.sql.includes("update call_pcaps"));
    assert.deepEqual(metadataUpdate?.params, [[captureCallId]]);
    assert.match(metadataUpdate?.sql ?? "", /status = 'expired'/);
    assert.equal(retention.pcapFiles, 1);
  });
});

describe("retention advisory lock", () => {
  it("skips the run when another instance holds the advisory lock", async () => {
    let runnerCalls = 0;
    let released = false;
    const pool = lockPool(false, () => {
      released = true;
    });

    const result = await runRetentionWithAdvisoryLock(
      pool,
      { callRetentionDays: 7, recordingRetentionDays: 30, pcapRetentionDays: 7 },
      {
        runner: async () => {
          runnerCalls += 1;
          return retentionResult();
        }
      }
    );

    assert.deepEqual(result, { status: "locked" });
    assert.equal(runnerCalls, 0);
    assert.equal(released, true);
  });

  it("holds and releases the advisory lock around one retention run", async () => {
    const queries: string[] = [];
    let released = false;
    const pool = lockPool(
      true,
      () => {
        released = true;
      },
      queries
    );

    const locked = await runRetentionWithAdvisoryLock(
      pool,
      { callRetentionDays: 7, recordingRetentionDays: 30, pcapRetentionDays: 7 },
      { runner: async (_pool, input) => ({ ...retentionResult(), ...input }) }
    );

    assert.equal(locked.status, "completed");
    assert.equal(
      queries.some((sql) => sql.includes("pg_advisory_unlock")),
      true
    );
    assert.equal(released, true);
  });
});

function retentionResult() {
  return {
    dryRun: false as const,
    callRetentionDays: 7,
    recordingRetentionDays: 30,
    pcapRetentionDays: 7,
    calls: 0,
    recordingFiles: 0,
    pcapFiles: 0
  };
}

function queryPool(handler: (sql: string, params: readonly unknown[]) => QueryResult): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

function transactionalPool(
  poolHandler: (sql: string, params: readonly unknown[]) => QueryResult,
  clientHandler: (sql: string, params: readonly unknown[]) => QueryResult
): pg.Pool {
  const client = {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(clientHandler(sql, params)),
    release: () => undefined
  };
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(poolHandler(sql, params)),
    connect: () => Promise.resolve(client)
  } as unknown as pg.Pool;
}

function lockPool(acquired: boolean, onRelease: () => void, queries: string[] = []): pg.Pool {
  const client = {
    query: (sql: string) => {
      queries.push(sql);
      return Promise.resolve(
        sql.includes("pg_try_advisory_lock") ? rows([{ acquired }]) : rows([{ unlocked: true }])
      );
    },
    release: onRelease
  };
  return { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
}

type QueryResult = { rows: any[]; rowCount: number };

function rows<T>(items: T[]): QueryResult {
  return result(items, items.length);
}

function result<T>(items: T[], rowCount: number): QueryResult {
  return { rows: items, rowCount };
}
