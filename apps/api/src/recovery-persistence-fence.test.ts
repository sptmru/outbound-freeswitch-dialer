import assert from "node:assert/strict";
import { test } from "node:test";
import { RecoveryPersistenceFence } from "./recovery-persistence-fence.js";
import { OrderedRetryQueue } from "./ordered-retry-queue.js";

test("H01 persistence tickets require subscription, idle queue and no intervening event or loss", async () => {
  let stopped = false;
  let finish!: () => void;
  const processed = new Promise<void>((r) => {
    finish = r;
  });
  const queue = new OrderedRetryQueue({
    maxSize: 4,
    initialRetryMilliseconds: 1,
    maxRetryMilliseconds: 1,
    isTransientError: () => false,
    process: async () => processed
  });
  const fence = new RecoveryPersistenceFence(queue, () => stopped);
  assert.equal(fence.ticket(), null);
  fence.subscribed();
  const old = fence.ticket()!;
  assert.equal(old(), true);
  fence.arrived();
  queue.enqueue("terminal event");
  assert.equal(old(), false);
  assert.equal(fence.ticket(), null);
  let drained = false;
  const wait = fence.waitForIdle().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  finish();
  await wait;
  const fresh = fence.ticket()!;
  assert.equal(fresh(), true);
  fence.disconnected();
  assert.equal(fresh(), false);
  assert.equal(fence.ticket(), null);
  fence.subscribed();
  assert.equal(fence.ticket()!(), true);
  fence.persistenceFailed();
  fence.disconnected();
  fence.subscribed();
  assert.equal(fence.ticket(), null, "reconnect cannot repair a discarded persistence event");
  stopped = true;
  assert.equal(fence.ticket(), null);
  queue.stop();
});
