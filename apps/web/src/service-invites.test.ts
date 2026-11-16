import { describe, it, expect } from "vitest";
import { serviceInviteIdentity, serviceInviteMatches } from "./service-invites";
import type { DeskSessionSnapshot } from "./types";
const id = "10000000-0000-4000-8000-000000000001";
const session = { id, bindingGeneration: "9007199254740993" } as DeskSessionSnapshot;
const valid = {
  "X-Outbound-Dialer-Call-ID": id,
  "X-Outbound-Dialer-Operation-ID": id,
  "X-Outbound-Dialer-Desk-Session-ID": id,
  "X-Outbound-Dialer-Binding-Generation": session.bindingGeneration,
  "X-Outbound-Dialer-Leg-ID": id,
  "Call-ID": "dialog@fixture.invalid"
};
const request = (h: Record<string, string>) => ({
  getHeader: (key: string) => h[key],
  getHeaders: (key: string) => (key in h ? [h[key]!] : [])
});
describe("E04.1 service INVITE identity", () => {
  it("requires every exact identity, preserves bigint and rejects duplicate/invalid headers", () => {
    const input = serviceInviteIdentity(request(valid), session)!;
    expect(input.bindingGeneration).toBe("9007199254740993");
    for (const key of Object.keys(valid)) {
      const h = { ...valid };
      delete h[key as keyof typeof valid];
      expect(serviceInviteIdentity(request(h), session)).toBeNull();
      expect(
        serviceInviteIdentity({ ...request(valid), getHeaders: () => ["one", "two"] }, session)
      ).toBeNull();
    }
    for (const binding of ["01", "0", "1", "9223372036854775808"])
      expect(
        serviceInviteIdentity(request({ ...valid, "X-Outbound-Dialer-Binding-Generation": binding }), session)
      ).toBeNull();
    expect(serviceInviteIdentity(request(valid), null)).toBeNull();
    expect(serviceInviteIdentity(request({ ...valid, "Call-ID": "bad\r\nheader" }), session)).toBeNull();
    expect(serviceInviteMatches(input, { authorized: true, ...input })).toBe(true);
    for (const k of Object.keys(input))
      expect(serviceInviteMatches(input, { authorized: true, ...input, [k]: "wrong" })).toBe(false);
  });
});
