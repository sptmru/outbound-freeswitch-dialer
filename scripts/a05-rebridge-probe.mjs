import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { render as renderBinding } from "./a04-binding-probe.mjs";
import { openEsl } from "./a02-ingress-probe.mjs";
import { uniqueEndpoint } from "./a04-binding.mjs";
import { endpoint, until, assertTone, decodeWav, power } from "./a05-media.mjs";
import { executorScenarios } from "./a05-executor.mjs";

export async function render(directory, identities = []) {
  await renderBinding(directory, identities);
  let xml = await readFile(join(directory, "freeswitch.xml"), "utf8");
  xml = xml
    .replace(
      '<load module="mod_tone_stream"/>',
      '<load module="mod_tone_stream"/><load module="mod_sndfile"/>'
    )
    .replace('name="max-sessions" value="8"', 'name="max-sessions" value="16"')
    .replace('name="rtp-end-port" value="20020"', 'name="rtp-end-port" value="20040"')
    .replace('name="auth-calls" value="true"', 'name="auth-calls" value="false"')
    .replace(
      '<action application="hangup" data="CALL_REJECTED"/>',
      '<action application="answer"/><action application="set" data="hangup_after_bridge=false"/><action application="set" data="park_after_bridge=true"/><action application="park"/>'
    );
  await writeFile(join(directory, "freeswitch.xml"), xml, { mode: 0o600 });
}

async function probe(directory) {
  const pool = new pg.Pool({
    host: join(directory, "socket"),
    user: "postgres",
    database: "a05",
    max: 5,
    connectionTimeoutMillis: 1000,
    query_timeout: 5000,
    options: "-c statement_timeout=5000 -c lock_timeout=3000"
  });
  const report = {
    date: new Date().toISOString(),
    node: process.version,
    scenarios: [],
    commands: [],
    media: "actual isolated UDP SIP/PCMU RTP; no browser/provider; no product schema"
  };
  const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  let esl;
  let chain = Promise.resolve();
  const clients = [];
  async function command(cmd) {
    const result = chain.then(() => esl.command(`api ${cmd}`));
    chain = result.catch(() => {});
    const response = (await result).body.trim();
    report.commands.push({ at: new Date().toISOString(), command: cmd, response });
    return response;
  }
  async function pass(name, evidence) {
    report.scenarios.push({ name, status: "passed", ...evidence });
    await save();
    console.log(`PASS ${name}`);
  }
  const exists = async (uuid) => (await command(`uuid_exists ${uuid}`)) === "true";
  async function originate(client, uuid = randomUUID()) {
    const destination = uniqueEndpoint(
      await command(`sofia_contact a04-loopback/${client.username}@a04.invalid`),
      client.username
    );
    assert.ok(destination, "Missing authoritative session endpoint");
    assert.match(
      await command(
        `originate {origination_uuid=${uuid},originate_timeout=3,hangup_after_bridge=false,park_after_bridge=true}${destination} &park()`
      ),
      /^\+OK/
    );
    await until(() => exists(uuid), "Originated leg absent");
    await until(
      () => esl.events.some((e) => e["event-name"] === "CHANNEL_PARK" && e["unique-id"] === uuid),
      "Originated leg not parked"
    );
    return uuid;
  }
  async function bridge(a, b) {
    const start = esl.events.length;
    assert.match(await command(`uuid_bridge ${a} ${b}`), /^\+OK/);
    await until(
      () =>
        esl.events
          .slice(start)
          .some(
            (e) =>
              e["event-name"] === "CHANNEL_BRIDGE" && e["unique-id"] === a && e["other-leg-unique-id"] === b
          ),
      "Actual bridge event not observed"
    );
    await until(async () => (await command(`uuid_getvar ${a} bridge_uuid`)) === b, "Bridge not confirmed");
  }
  async function media(client, frequency) {
    const start = client.received.length;
    await until(() => client.received.length >= start + 4000, "No new RTP samples");
    return assertTone(client.received.slice(start + 800, start + 4000), frequency);
  }
  async function kill(uuid) {
    if (await exists(uuid)) assert.match(await command(`uuid_kill ${uuid} NORMAL_CLEARING`), /^\+OK/);
    await until(async () => !(await exists(uuid)), "Channel cleanup failed");
  }
  try {
    await until(
      async () => {
        try {
          esl = await openEsl();
          return /RUNNING/.test((await esl.command("api sofia status")).body);
        } catch {
          esl?.close();
          return false;
        }
      },
      "FS startup failed",
      15000
    );
    await esl.command("event plain ALL");
    report.version = await command("version");
    const identities = ["customer", "source", "target"].map((name) => ({
      username: `desk_${name}`,
      password: randomBytes(24).toString("hex")
    }));
    await render(directory, identities);
    assert.match(await command("reloadxml"), /\+OK/);
    for (let i = 0; i < 3; i++) {
      const client = await endpoint({
        ...identities[i],
        source: `127.0.0.${i + 2}`,
        frequency: [440, 660, 880][i]
      });
      clients.push(client);
      await client.register();
      await until(
        async () =>
          uniqueEndpoint(
            await command(`sofia_contact a04-loopback/${client.username}@a04.invalid`),
            client.username
          ),
        "Registration not visible"
      );
    }
    const [customer, source, target] = clients;
    await executorScenarios({ pool, directory, esl, command, target, pass });
    for (const direction of ["inbound", "outbound"]) {
      for (const boundary of ["before-target", "before-park", "parked", "after-bridge"]) {
        const started = Date.now();
        let customerUuid;
        if (direction === "inbound") {
          const id = await customer.dial();
          customerUuid = await until(
            () =>
              esl.events.find(
                (e) => e["event-name"] === "CHANNEL_CREATE" && e["variable_sip_call_id"] === id
              )?.["unique-id"],
            "No actual inbound customer UUID"
          );
        } else customerUuid = await originate(customer);
        const sourceUuid = await originate(source);
        assert.equal(await command(`uuid_getvar ${customerUuid} hangup_after_bridge`), "false");
        const path = `/a02/${direction}-${boundary}.wav`;
        assert.match(await command(`uuid_setvar ${customerUuid} RECORD_STEREO true`), /^\+OK/);
        assert.match(await command(`uuid_record ${customerUuid} start ${path}`), /^\+OK/);
        await bridge(customerUuid, sourceUuid);
        const before = await Promise.all([media(customer, 660), media(source, 440)]);
        const bugsBefore = await command(`uuid_buglist ${customerUuid}`);
        assert.match(bugsBefore, /session_record/);
        const parkEventStart = esl.events.length;
        // Recipient normally parks first. The before-target case deliberately loses source earlier.
        if (boundary === "before-target") await source.bye();
        const targetUuid = await originate(target);
        if (boundary === "before-park") await source.bye();
        if (["parked", "after-bridge"].includes(boundary))
          assert.match(await command(`uuid_park ${customerUuid}`), /^\+OK/);
        await until(
          () =>
            esl.events
              .slice(parkEventStart)
              .some((e) => e["event-name"] === "CHANNEL_PARK" && e["unique-id"] === customerUuid),
          "Customer park not confirmed"
        );
        if (["parked", "after-bridge"].includes(boundary))
          await until(
            () =>
              esl.events
                .slice(parkEventStart)
                .some((e) => e["event-name"] === "CHANNEL_PARK" && e["unique-id"] === sourceUuid),
            "Source park not confirmed"
          );
        if (boundary === "parked") await source.bye();
        assert.equal(await exists(customerUuid), true);
        await bridge(customerUuid, targetUuid);
        if (boundary === "after-bridge") await source.bye();
        await until(async () => !(await exists(sourceUuid)), "Source teardown absent");
        // Replay the former agent's UUID-targeted teardown after handover.
        assert.match(await command(`uuid_kill ${sourceUuid} NORMAL_CLEARING`), /-ERR/);
        assert.equal(await command(`uuid_getvar ${customerUuid} bridge_uuid`), targetUuid);
        const after = await Promise.all([media(customer, 880), media(target, 440)]);
        const bugsAfter = await command(`uuid_buglist ${customerUuid}`);
        assert.equal((bugsAfter.match(/<function>session_record<\/function>/g) ?? []).length, 1);
        assert.match(await command(`uuid_record ${customerUuid} stop ${path}`), /^\+OK/);
        await kill(customerUuid);
        await kill(targetUuid);
        const wav = decodeWav(await readFile(join(directory, `${direction}-${boundary}.wav`)));
        assert.equal(wav.channels, 2);
        const recording = [440, 660, 880].map((frequency) => {
          let peak = 0;
          for (let offset = 0; offset + 3200 <= wav.samples.length; offset += 800)
            for (let channel = 0; channel < wav.channels; channel++)
              peak = Math.max(
                peak,
                power(
                  wav.samples.slice(offset, offset + 3200).map((s) => s[channel]),
                  frequency
                )
              );
          return { frequency, peak, status: peak > 500 ? "passed" : "failed" };
        });
        assert.ok(Date.now() - started < 15000, "Recovery exceeded 15s lab bound");
        const evidence = {
          customerUuid,
          sourceUuid,
          targetUuid,
          before,
          after,
          recording,
          recordingFrames: wav.samples.length,
          recoveryMs: Date.now() - started,
          bugsBefore,
          bugsAfter
        };
        const name = `A05.1/A05.3 ${direction}, source disappears ${boundary}`;
        if (recording.every((r) => r.status === "passed")) await pass(name, evidence);
        else {
          report.scenarios.push({ name, status: "failed", mediaAndRecovery: "passed", ...evidence });
          await save();
          console.log(`FAIL ${name}: decoded recording tone check`);
        }
      }
    }
    report.events = esl.events.map((e) =>
      Object.fromEntries(
        Object.entries(e).filter(([k]) =>
          [
            "event-name",
            "event-date-timestamp",
            "unique-id",
            "other-leg-unique-id",
            "hangup-cause",
            "job-uuid",
            "variable_sip_call_id"
          ].includes(k)
        )
      )
    );
    for (const client of clients) assert.deepEqual(client.errors, []);
    // FS's SQL-backed channel inventory can lag the live UUID registry/events.
    // Wait for bounded convergence; never infer zero resources from uuid_exists alone.
    report.finalChannels = await until(async () => {
      const count = await command("show channels count");
      return /^0 total/.test(count) ? count : false;
    }, "FS channel inventory did not converge to zero within 5s");
    await pass("A05 cleanup: zero actual channels and no endpoint errors", {});
    assert.equal(
      report.scenarios.filter((s) => s.status === "failed").length,
      0,
      "A05 recording runtime gate remains open; see report.json and WAV artifacts"
    );
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    await save();
    for (const client of clients) client.close();
    esl?.close();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory] = process.argv.slice(2);
  assert.ok(directory?.startsWith("/tmp/outbound-a05."), "A05 private lab directory required");
  if (mode === "render") await render(directory);
  else if (mode === "probe") await probe(directory);
  else throw new Error("Expected render or probe");
}
