export class CoalescedTask {
  private readonly idleWaiters = new Set<() => void>();
  private requested = false;
  private running = false;
  private stopped = false;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly onError: (error: unknown) => void
  ) {}

  request(): void {
    if (this.stopped) {
      return;
    }
    this.requested = true;
    void this.run();
  }

  waitForIdle(): Promise<void> {
    if (!this.requested && !this.running) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  stop(): void {
    this.stopped = true;
    this.requested = false;
    if (!this.running) {
      this.resolveIdleWaiters();
    }
  }

  private async run(): Promise<void> {
    if (this.running || this.stopped) {
      return;
    }
    this.running = true;
    try {
      while (this.requested && !this.stopped) {
        this.requested = false;
        try {
          await this.task();
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.running = false;
      if (this.requested && !this.stopped) {
        void this.run();
      } else {
        this.resolveIdleWaiters();
      }
    }
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}
