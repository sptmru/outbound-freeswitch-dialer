export interface OrderedRetryQueueOptions<T> {
  initialRetryMilliseconds: number;
  isTransientError: (error: unknown) => boolean;
  maxRetryMilliseconds: number;
  maxSize: number;
  onDepthChanged?: (depth: number) => void;
  onPermanentFailure?: (error: unknown, item: T) => void;
  onRetry?: (error: unknown, item: T, attempt: number, delayMilliseconds: number) => void;
  process: (item: T) => Promise<void>;
}

interface QueueEntry<T> {
  attempts: number;
  item: T;
}

export class OrderedRetryQueue<T> {
  readonly maxSize: number;

  private readonly entries: Array<QueueEntry<T>> = [];
  private readonly idleWaiters = new Set<() => void>();
  private processing = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: OrderedRetryQueueOptions<T>) {
    if (!Number.isInteger(options.maxSize) || options.maxSize < 1) {
      throw new Error("OrderedRetryQueue maxSize must be a positive integer");
    }
    this.maxSize = options.maxSize;
    options.onDepthChanged?.(0);
  }

  get size(): number {
    return this.entries.length;
  }

  get isAtCapacity(): boolean {
    return this.entries.length >= this.maxSize;
  }

  enqueue(item: T): boolean {
    if (this.stopped || this.isAtCapacity) {
      return false;
    }

    this.entries.push({ attempts: 0, item });
    this.options.onDepthChanged?.(this.entries.length);
    void this.drain();
    return true;
  }

  waitForIdle(): Promise<void> {
    if (!this.entries.length && !this.processing && !this.retryTimer) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  stop(): number {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const discarded = this.entries.length;
    this.entries.length = 0;
    this.options.onDepthChanged?.(0);
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
    return discarded;
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.processing || this.retryTimer) {
      return;
    }

    const entry = this.entries[0];
    if (!entry) {
      this.resolveIdleWaiters();
      return;
    }

    this.processing = true;
    try {
      await this.options.process(entry.item);
      if (!this.stopped && this.entries[0] === entry) {
        this.entries.shift();
        this.options.onDepthChanged?.(this.entries.length);
      }
    } catch (error) {
      if (this.stopped || this.entries[0] !== entry) {
        return;
      }

      if (this.options.isTransientError(error)) {
        entry.attempts += 1;
        const delayMilliseconds = this.retryDelay(entry.attempts);
        this.options.onRetry?.(error, entry.item, entry.attempts, delayMilliseconds);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.drain();
        }, delayMilliseconds);
      } else {
        this.entries.shift();
        this.options.onDepthChanged?.(this.entries.length);
        this.options.onPermanentFailure?.(error, entry.item);
      }
    } finally {
      this.processing = false;
    }

    if (!this.retryTimer) {
      void this.drain();
    }
  }

  private retryDelay(attempt: number): number {
    const exponent = Math.min(Math.max(attempt - 1, 0), 30);
    return Math.min(this.options.maxRetryMilliseconds, this.options.initialRetryMilliseconds * 2 ** exponent);
  }

  private resolveIdleWaiters(): void {
    if (this.entries.length || this.processing || this.retryTimer) {
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}
