// Heterogeneous SQL/HTTP snapshots in an isolated, test-only JS fixture.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function supervisorFixture(config: any): Promise<any>;
export function limitedExecutor(fixture: any, config: any): Promise<any>;
export function supervisorHttp(fixture: any, actor: any, options?: any): Promise<any>;
export function mockSupervisorEsl(onCommand: any, options?: any): Promise<any>;
