import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  atomicConfigurationWrite,
  renderInboundConfiguration,
  validateInboundPolicy,
  validateInboundXml,
  type InboundRoute
} from "./inbound-config.js";
const policy = { trustedCidrs: "127.0.0.2/32", preAdmission: 8, trunk: 40, waitSeconds: 3 };
const route = (): InboundRoute => ({
  id: randomUUID(),
  queue_id: randomUUID(),
  campaign_id: randomUUID(),
  normalized_did: "+12025550100",
  enabled: true,
  desired_revision: "1",
  queue_revision: "1",
  queue_timeout_ms: 60000
});

test("D02.1 U: bounded trusted DID routes never answer, bridge, trust headers or permit browser PSTN", async () => {
  const r = route();
  const { xml, hash } = await renderInboundConfiguration(
    [r, { ...route(), normalized_did: "+12025550101", enabled: false }],
    policy
  );
  assert.match(xml, /\$\{acl\(\$\{network_addr\} 127\.0\.0\.2\/32\)\}/);
  assert.match(xml, /403 Untrusted ingress/);
  assert.match(xml, /403 DID disabled/);
  assert.match(xml, /404 Unknown DID/);
  assert.match(xml, /503 Admission unavailable/);
  assert.match(xml, /hash outbound_dialer pre_admission 8/);
  assert.match(xml, /hash outbound_dialer trunk 40/);
  assert.match(xml, /sched_hangup" data="\+3/);
  assert.match(xml, /outbound_dialer_ingress_uuid=\$\{uuid\}/);
  assert.ok(xml.includes(`d02_revision_${hash}`));
  assert.doesNotMatch(
    xml,
    /application="(?:answer|pre_answer|bridge|originate|park|playback)"|sip_h_|X-Outbound|sofia\//
  );
  assert.equal(
    (await renderInboundConfiguration([r], policy)).hash,
    (await renderInboundConfiguration([r], policy)).hash
  );
  assert.notEqual(
    (await renderInboundConfiguration([r], policy)).hash,
    (await renderInboundConfiguration([r], { ...policy, trunk: 39 })).hash
  );
});

test("D02.2 U: reject malformed XML, unbounded policy, duplicate DID and configuration/command injection before write", async () => {
  for (const cidr of [
    "",
    "0.0.0.0/0",
    "::/0",
    "127.0.0.2/33",
    "127.0.0.2/32\n<evil/>",
    "${api(system x)}/32"
  ])
    assert.throws(() => validateInboundPolicy({ ...policy, trustedCidrs: cidr }));
  for (const n of [0, 17, NaN, 1.5])
    assert.throws(() => validateInboundPolicy({ ...policy, preAdmission: n }));
  const r = route();
  for (const invalid of [
    { ...r, normalized_did: '+12025550100"/>' },
    { ...r, queue_id: "${system(foo)}" },
    { ...r, desired_revision: "1;system" },
    { ...r, queue_timeout_ms: Infinity }
  ])
    await assert.rejects(renderInboundConfiguration([invalid], policy));
  await assert.rejects(renderInboundConfiguration([r, { ...r, id: randomUUID() }], policy));
  assert.throws(() => validateInboundXml("<include><extension></include>"));
  assert.throws(() => validateInboundXml("<!DOCTYPE include><include/>"));
});

test("D02.2 U: atomic writer exposes complete bundles and removes temporary files after failure", async () => {
  const dir = await mkdtemp("/tmp/d02-write-");
  try {
    const path = join(dir, "active.xml");
    await atomicConfigurationWrite(path, "old");
    await atomicConfigurationWrite(path, "new");
    assert.equal(await readFile(path, "utf8"), "new");
    await assert.rejects(atomicConfigurationWrite(dir, "not a file"));
    assert.deepEqual(await readdir(dir), ["active.xml"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
