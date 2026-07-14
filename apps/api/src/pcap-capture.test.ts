import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { __testing, callPcapPath, startCallPcapCapture } from "./pcap-capture.js";

const callId = "11111111-1111-4111-8111-111111111111";

describe("per-call PCAP capture control", () => {
  it("starts the supervisor before marking the capture active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-pcap-"));
    const config = captureConfig(directory);
    const requests: string[] = [];
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = queryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("status = 'capturing'") && sql.includes("returning call_id")) {
        return rows([{ call_id: callId }]);
      }
      return rows([]);
    });

    try {
      await startCallPcapCapture(pool, config, callId, undefined, {
        requestCapture: async (_socketPath, requestedCallId, action) => {
          requests.push(`${requestedCallId}:${action}`);
          return { callId: requestedCallId, running: true };
        }
      });
      assert.equal(requests[0], `${callId}:start`);
      assert.ok(queries.some((query) => query.sql.includes("status = 'capturing'")));
      assert.ok(queries.some((query) => query.params.includes("pcap_capture_started")));
      assert.equal(
        queries.find((query) => query.sql.includes("status = 'capturing'"))?.params[1],
        join(directory, `${callId}.pcap`)
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("finalizes a stopped non-empty capture as available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-pcap-"));
    const config = captureConfig(directory);
    const requests: string[] = [];
    const filePath = callPcapPath(directory, callId);
    await writeFile(filePath, Buffer.alloc(64, 1));
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = queryPool((sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("from call_events")) {
        return rows([
          {
            raw_json: {
              headers: {
                variable_local_media_port: "16420",
                variable_sip_call_id: "call@example.net"
              }
            }
          }
        ]);
      }
      return rows([]);
    });
    const logger = { info() {}, warn() {}, error() {} };

    try {
      await __testing.finalizeCallPcapCapture(
        pool,
        config,
        { call_id: callId, file_path: filePath },
        logger,
        {
          requestCapture: async (_socketPath, requestedCallId, action, selection) => {
            requests.push(`${requestedCallId}:${action}`);
            assert.deepEqual(selection, {
              mediaPorts: [16420, 16421],
              sipCallIds: ["call@example.net"]
            });
            return { callId: requestedCallId, running: false, fileSizeBytes: 64 };
          }
        }
      );
      assert.equal(requests[0], `${callId}:stop`);
      assert.ok(queries.some((query) => query.sql.includes("status = 'available'")));
      assert.ok(queries.some((query) => query.params.includes("pcap_capture_available")));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-UUID file names", () => {
    assert.throws(() => callPcapPath("/tmp/pcaps", "../../secrets"), /Invalid call ID/);
  });

  it("records only one lifecycle event when concurrent callers activate the same capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-pcap-"));
    const config = captureConfig(directory);
    let pending = true;
    const events: string[] = [];
    const pool = queryPool((sql, params) => {
      if (sql.includes("status = 'capturing'") && sql.includes("returning call_id")) {
        if (!pending) return rows([]);
        pending = false;
        return rows([{ call_id: callId }]);
      }
      if (sql.includes("insert into call_events")) {
        events.push(String(params[1]));
      }
      return rows([]);
    });
    const requestCapture = async () => ({ callId, running: true });

    try {
      await Promise.all([
        startCallPcapCapture(pool, config, callId, undefined, { requestCapture }),
        startCallPcapCapture(pool, config, callId, undefined, { requestCapture })
      ]);
      assert.deepEqual(events, ["pcap_capture_started"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads isolation inputs only from persisted FreeSWITCH events", async () => {
    const pool = queryPool((sql) => {
      assert.match(sql, /freeswitch_event_name is not null/);
      return rows([
        { raw_json: { headers: { variable_local_media_port: "16460" } } },
        { raw_json: { not_headers: { variable_local_media_port: "16480" } } }
      ]);
    });

    assert.deepEqual(await __testing.loadPcapFilterSelection(pool, callId), {
      mediaPorts: [16460, 16461],
      sipCallIds: []
    });
  });
});

function captureConfig(directory: string): AppConfig {
  return {
    PCAP_CAPTURE_ENABLED: true,
    PCAP_CAPTURE_SOCKET: join(directory, "capture.sock"),
    PCAP_STORAGE_DIR: directory
  } as AppConfig;
}

function queryPool(handler: (sql: string, params: readonly unknown[]) => QueryResult): pg.Pool {
  return {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(handler(sql, params))
  } as unknown as pg.Pool;
}

type QueryResult = { rows: any[]; rowCount: number };

function rows<T>(items: T[]): QueryResult {
  return { rows: items, rowCount: items.length };
}
