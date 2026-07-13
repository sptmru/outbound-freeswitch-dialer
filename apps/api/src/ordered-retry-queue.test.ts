import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OrderedRetryQueue } from "./ordered-retry-queue.js";

describe("OrderedRetryQueue", () => {
  it("retries transient failures without allowing later items to overtake", async () => {
    const attempts: string[] = [];
    let failuresRemaining = 2;
    const retries: number[] = [];
    const queue = new OrderedRetryQueue<string>({
      initialRetryMilliseconds: 1,
      isTransientError: (error) => (error as { code?: string }).code === "08006",
      maxRetryMilliseconds: 2,
      maxSize: 4,
      onRetry: (_error, _item, attempt) => retries.push(attempt),
      process: async (item) => {
        attempts.push(item);
        if (item === "first" && failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw Object.assign(new Error("database connection lost"), { code: "08006" });
        }
      }
    });

    assert.equal(queue.enqueue("first"), true);
    assert.equal(queue.enqueue("second"), true);
    await queue.waitForIdle();

    assert.deepEqual(attempts, ["first", "first", "first", "second"]);
    assert.deepEqual(retries, [1, 2]);
    assert.equal(queue.size, 0);
  });

  it("rejects overflow without evicting an already queued item", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new OrderedRetryQueue<string>({
      initialRetryMilliseconds: 1,
      isTransientError: () => false,
      maxRetryMilliseconds: 1,
      maxSize: 1,
      process: async () => blocked
    });

    assert.equal(queue.enqueue("retained"), true);
    assert.equal(queue.enqueue("overflow"), false);
    assert.equal(queue.size, 1);

    release();
    await queue.waitForIdle();
  });

  it("reports permanent failures and continues with the next item", async () => {
    const processed: string[] = [];
    const failed: string[] = [];
    const queue = new OrderedRetryQueue<string>({
      initialRetryMilliseconds: 1,
      isTransientError: () => false,
      maxRetryMilliseconds: 1,
      maxSize: 4,
      onPermanentFailure: (_error, item) => failed.push(item),
      process: async (item) => {
        processed.push(item);
        if (item === "invalid") {
          throw new Error("invalid persistence operation");
        }
      }
    });

    queue.enqueue("invalid");
    queue.enqueue("valid");
    await queue.waitForIdle();

    assert.deepEqual(processed, ["invalid", "valid"]);
    assert.deepEqual(failed, ["invalid"]);
  });

  it("resolves idle waiters and reports discarded work when stopped", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new OrderedRetryQueue<string>({
      initialRetryMilliseconds: 1,
      isTransientError: () => false,
      maxRetryMilliseconds: 1,
      maxSize: 2,
      process: async () => blocked
    });

    queue.enqueue("in-flight");
    const idle = queue.waitForIdle();
    assert.equal(queue.stop(), 1);
    await idle;
    release();
  });
});
