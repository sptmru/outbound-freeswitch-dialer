import type { RecoveryBarrier } from "./inbound-recovery.js";

/** Process-local observation ticket, subordinate to durable state and the C03
 * execution lock. This is not a distributed sender fence or a media capability.
 */
export class RecoveryPersistenceFence implements RecoveryBarrier {
  private revision = 0;
  private connected = false;
  private failed = false;
  constructor(
    private readonly queue: { waitForIdle(): Promise<void>; readonly size: number },
    private readonly stopped: () => boolean
  ) {}
  arrived() {
    this.revision++;
  }
  subscribed() {
    this.revision++;
    this.connected = true;
  }
  disconnected() {
    this.revision++;
    this.connected = false;
  }
  persistenceFailed() {
    this.revision++;
    this.failed = true;
  }
  waitForIdle() {
    return this.queue.waitForIdle();
  }
  ticket() {
    const valid = () => !this.stopped() && this.connected && !this.failed && this.queue.size === 0;
    if (!valid()) return null;
    const revision = this.revision;
    return () => valid() && revision === this.revision;
  }
}
