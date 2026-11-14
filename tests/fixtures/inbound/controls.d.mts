export const checkpoints: readonly string[];
export function invariant(condition: unknown, message: string): asserts condition;
export function assertLedger(rows: Array<{ operation: string; stage: string }>): void;
export class EventTape<T> {
  constructor(events: T[], seed?: number);
  readonly seed: number;
  cursor: number;
  next(deliver: (event: T) => void): boolean;
  replay(indices: number[], deliver: (event: T) => void): void;
  reset(): void;
}
