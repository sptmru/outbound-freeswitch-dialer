export function testDatabaseUrl(env?: Record<string, string | undefined>): string;
export function harnessSelfCheck(env?: Record<string, string | undefined>): Promise<{
  status: string;
  scenarios: unknown[];
  cleanup?: { schemaRemoved: boolean; workersExited: boolean };
}>;
import type { Pool, PoolConfig } from "pg";
export function databaseConfig(value: string, schema?: string): PoolConfig;
export function createFixtureLogin(
  admin: Pool,
  config: PoolConfig,
  role: string,
  connectionLimit: number
): Promise<PoolConfig>;
export function prepareInboundArtifacts(env?: Record<string, string | undefined>): Promise<void>;
import type { ChildProcess } from "node:child_process";
export interface FixtureWorker {
  child: ChildProcess;
  send(type: string, extra?: Record<string, unknown>): void;
  wait(type: string): Promise<{ type: string; pid: number; backend: number }>;
  stop(): Promise<void>;
  finished(): Promise<void>;
}
export interface DatabaseFixture {
  pool: Pool;
  schema: string;
  transcript: Array<Record<string, unknown>>;
  worker(operation: "a" | "b"): FixtureWorker;
  snapshot(): Promise<{
    claims: Array<{ resource: string; operation: string }>;
    work: Array<{ operation: string; state: string }>;
    ledger: Array<{ operation: string; stage: string }>;
  }>;
  cleanup(): Promise<{ schemaRemoved: boolean; workersExited: boolean }>;
}
export function createDatabaseFixture(env?: Record<string, string | undefined>): Promise<DatabaseFixture>;
export function assertBlocked(pool: Pool, blocked: number, blocker: number): Promise<void>;
