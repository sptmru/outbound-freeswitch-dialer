type InFlightOperation = {
  action: string;
  promise: Promise<unknown>;
};

export class PcapOperationCoordinator {
  readonly #inFlight = new Map<string, InFlightOperation>();

  async run<T>(callId: string, action: string, operation: () => Promise<T>): Promise<T> {
    const current = this.#inFlight.get(callId);
    if (current) {
      if (current.action === action) {
        return current.promise as Promise<T>;
      }
      await current.promise.catch(() => undefined);
      return this.run(callId, action, operation);
    }

    const promise = operation();
    this.#inFlight.set(callId, { action, promise });
    try {
      return await promise;
    } finally {
      const latest = this.#inFlight.get(callId);
      if (latest?.promise === promise) {
        this.#inFlight.delete(callId);
      }
    }
  }
}
