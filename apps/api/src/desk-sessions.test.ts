import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "./config.js";
import { deskTelephony, verifiedDeskContact } from "./desk-sessions.js";

test("D01 strict authoritative contact accepts one endpoint and rejects routing expressions", () => {
  const username = "desk_0123456789abcdef0123456789abcdef";
  const contact = `sofia/internal-webrtc/sip:${username}@127.0.0.2:5060;transport=wss`;
  assert.equal(verifiedDeskContact(contact, username), contact);
  const wss = `${contact};fs_nat=yes;fs_path=${encodeURIComponent(`sip:${username}@127.0.0.1:6090;transport=wss`)}`;
  assert.equal(verifiedDeskContact(wss, username), wss);
  assert.equal(
    verifiedDeskContact(`${contact};fs_path=${encodeURIComponent("sip:other@127.0.0.1")}`, username),
    null
  );
  for (const value of [
    "-ERR USER_NOT_REGISTERED",
    `${contact},${contact}`,
    `${contact}|${contact}`,
    `${contact}\n${contact}`,
    `{execute_on_answer=system:bad}${contact}`,
    contact.replace(username, "other"),
    contact.replace("internal-webrtc", "external"),
    `${contact};fs_path=sip:bad`,
    `${contact} bad`
  ])
    assert.equal(verifiedDeskContact(value, username), null, value);
});

test("D01 telephony refuses non-generation identities before provisioning, lookup or cleanup commands", async () => {
  const telephony = deskTelephony({
    FREESWITCH_ESL_ENABLED: true,
    FREESWITCH_DOMAIN: "fixture.invalid"
  } as AppConfig);
  for (const username of ["legacy_agent", "desk_bad\nshutdown", "profile all", "desk_0123"]) {
    assert.equal(await telephony.lookup(username), "");
    await assert.rejects(telephony.provision(username, "fixture"), /endpoint_unavailable/);
    await assert.rejects(telephony.remove(username), /endpoint_unavailable/);
  }
});
