import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessSelfCheck } from "../../../tests/fixtures/inbound/database.mjs";

test(
  "A07.1–A07.2 isolated PostgreSQL barriers, both orders, rollback and cleanup",
  {
    skip: !process.env.TEST_DATABASE_URL
      ? "TEST_DATABASE_URL absent; dedicated test:inbound:db requires it"
      : false,
    timeout: 60000
  },
  async () => {
    const report = await harnessSelfCheck();
    assert.equal(report.status, "passed");
    assert.equal(report.scenarios.length, 8);
    assert.deepEqual(report.cleanup, { schemaRemoved: true, workersExited: true });
  }
);
