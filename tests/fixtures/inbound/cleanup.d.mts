// Heterogeneous SQL snapshots in a test-only JS fixture.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function cleanupFixture(config: any, options?: { onPoolError?: (error: Error) => void }): Promise<any>;
