import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { openEsl } from "./a02-ingress-probe.mjs";
import { localSipClient as sipClient } from "../tests/fixtures/inbound/sip.mjs";
import { schema, takeover, verify, heartbeat, reserve, accepts, OCCUPIED } from "./a04-binding.mjs";

export async function render(directory, identities = []) {
  let xml = await readFile(
    new URL("../infra/freeswitch/prototypes/a02/freeswitch.xml.tpl", import.meta.url),
    "utf8"
  );
  xml = xml
    .replace('name="sessions-per-second" value="8"', 'name="sessions-per-second" value="50"')
    .replaceAll("a02-loopback", "a04-loopback")
    .replace('name="disable-register" value="true"', 'name="disable-register" value="false"')
    .replace(
      '<param name="auth-calls" value="false"/>',
      `<param name="auth-calls" value="true"/>
      <param name="accept-blind-reg" value="false"/>
      <param name="challenge-realm" value="a04.invalid"/>
      <param name="force-register-domain" value="a04.invalid"/>
      <param name="force-register-db-domain" value="a04.invalid"/>
      <param name="inbound-reg-force-matching-username" value="true"/>
      <param name="multiple-registrations" value="contact"/>
      <param name="max-registrations-per-extension" value="2"/>`
    )
    .replace("__A02_ACTIONS__", '<action application="hangup" data="CALL_REJECTED"/>');
  // Replace the entire A02 ingress dialplan: clients cannot dial any destination.
  xml =
    xml.slice(0, xml.indexOf('  <section name="dialplan">')) +
    `
  <section name="dialplan"><context name="a02-ingress"><extension name="deny"><condition>
    <action application="hangup" data="CALL_REJECTED"/>
  </condition></extension></context></section>
  <section name="directory"><domain name="a04.invalid"><groups><group name="default"><users>
    ${identities
      .map(({ username, password }) => {
        assert.match(username, /^desk_[a-z0-9_]+$/);
        assert.match(password, /^[0-9a-f]+$/);
        return `<user id="${username}"><params><param name="password" value="${password}"/></params>
        <variables><variable name="user_context" value="a02-ingress"/></variables></user>`;
      })
      .join("\n")}
  </users></group></groups></domain></section>
</document>\n`;
  await writeFile(join(directory, "freeswitch.xml"), xml, { mode: 0o600 });
}

async function until(fn, message, ms = 5000) {
  const deadline = Date.now() + ms;
  do {
    const result = await fn();
    if (result) return result;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function probe(directory) {
  const pool = new pg.Pool({
    host: join(directory, "socket"),
    user: "postgres",
    database: "a04",
    max: 4,
    connectionTimeoutMillis: 1000,
    query_timeout: 10000,
    options: "-c statement_timeout=10000 -c lock_timeout=5000"
  });
  const report = {
    date: new Date().toISOString(),
    node: process.version,
    scenarios: [],
    commands: [],
    media: "real local UDP SIP/RTP; simulated Desk controls, no browser/provider"
  };
  const clients = [];
  const identities = [];
  let esl;
  let queue = Promise.resolve();
  async function command(command) {
    const result = queue.then(() => esl.command(`api ${command}`));
    queue = result.catch(() => {});
    const response = (await result).body.trim();
    report.commands.push({ command, response });
    return response;
  }
  const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  async function pass(name, evidence = {}) {
    report.scenarios.push({ name, status: "passed", ...evidence });
    await save();
    console.log(`PASS ${name}`);
  }
  const row = async () => (await pool.query("SELECT * FROM a04_desk WHERE agent=1")).rows[0];
  const lookup = async (username) => {
    const result = await command(`sofia_contact a04-loopback/${username}@a04.invalid`);
    if (result.startsWith("error/")) await command("sofia status profile a04-loopback reg");
    return result;
  };
  async function provision(name, source) {
    const identity = {
      username: `desk_${name}_${randomBytes(4).toString("hex")}`,
      password: randomBytes(24).toString("hex")
    };
    identities.push(identity);
    await render(directory, identities);
    assert.match(await command("reloadxml"), /\+OK/);
    const client = await sipClient({
      ...identity,
      source,
      authorize: async (headers) => accepts(pool, client.binding, headers)
    });
    clients.push(client);
    return client;
  }
  async function ready(binding) {
    // A REGISTER 200 can precede visibility in the registration lookup. Remain unavailable
    // until authoritative evidence converges; no register/originate is retried here.
    return until(async () => {
      const result = await verify(pool, binding, lookup);
      return result?.ready ? result : false;
    }, "Not exactly one authoritative registration within 5s");
  }
  // All three shapes deliberately share the same endpoint primitive. No product transfer/bridge is claimed.
  async function service(binding, shape, { stale = false } = {}) {
    const uuid = randomUUID();
    const count = clients.map((c) => c.invites.length);
    const packetsBefore = clients.map((c) => c.packets);
    const body = `originate {origination_uuid=${uuid},originate_timeout=3,ignore_early_media=true,sip_h_X-A04-Session=${binding.session},sip_h_X-A04-Generation=${binding.generation},sip_h_X-A04-Operation=${binding.operation ?? randomUUID()},sip_h_X-A04-Shape=${shape}}${binding.endpoint} &playback(tone_stream://%(60000,0,440))`;
    // bgapi acknowledgements are not endpoint or media proof; inspect actual INVITEs, UUID and RTP below.
    const result = await queue.then(() => esl.command(`bgapi ${body}`));
    report.commands.push({ command: body, response: result.headers["reply-text"] });
    const recipient = await until(
      () => clients.find((c, i) => c.invites.length > count[i]),
      "No service INVITE"
    );
    const invite = recipient.invites.at(-1);
    assert.equal(invite.headers["x-a04-shape"], shape);
    assert.equal(invite.accepted, !stale);
    if (!stale) {
      assert.equal(recipient.username, binding.username);
      await until(
        async () =>
          (await command(`uuid_exists ${uuid}`)) === "true" &&
          recipient.packets > packetsBefore[clients.indexOf(recipient)] + 3,
        "No live media leg"
      );
    } else {
      await until(
        async () =>
          esl.events.some((e) => e["unique-id"] === uuid && e["event-name"] === "CHANNEL_HANGUP_COMPLETE"),
        "Rejected stale leg not finalized"
      );
      assert.equal(await command(`uuid_exists ${uuid}`), "false");
    }
    assert.deepEqual(
      clients.map((c, i) => c.invites.length - count[i]),
      clients.map((c) => (c === recipient ? 1 : 0))
    );
    return { uuid, recipient, invite };
  }
  async function hangup(uuid) {
    assert.match(await command(`uuid_kill ${uuid} NORMAL_CLEARING`), /^\+OK/);
    await until(async () => (await command(`uuid_exists ${uuid}`)) === "false", "Leg leaked");
    await pool.query("UPDATE a04_desk SET slot='idle',operation=NULL WHERE agent=1");
  }
  try {
    await until(
      async () => {
        try {
          esl = await openEsl();
          return /a04-loopback.*RUNNING/.test((await esl.command("api sofia status")).body);
        } catch {
          esl?.close();
          return false;
        }
      },
      "FreeSWITCH unavailable",
      15000
    );
    report.version = await command("version");
    await esl.command("event plain ALL");
    await schema(pool);
    const a = await provision("a", "127.0.0.2");
    const b = await provision("b", "127.0.0.3");
    a.binding = await takeover(pool, "tab_a", a.username);
    assert.equal((await row()).ready, false);
    assert.equal((await verify(pool, a.binding, lookup)).ready, false);
    assert.equal(await a.register(), 200);
    assert.equal(await b.register(), 200);
    a.binding = await ready(a.binding);
    const routes = [];
    let lastAuthorizedA;
    for (const order of [
      [a, b],
      [b, a]
    ]) {
      for (const c of order) assert.equal(await c.register(), 200);
      for (const shape of ["inbound", "outbound", "transfer"]) {
        a.binding = await ready(a.binding);
        const reserved = await reserve(pool, a.binding);
        lastAuthorizedA = reserved;
        const call = await service(reserved, shape);
        routes.push({
          order: order.map((c) => c.username),
          shape,
          uuid: call.uuid,
          destination: call.invite.destination,
          packets: a.packets
        });
        await hangup(call.uuid);
      }
    }
    await pass("A04.1 two authenticated registrations, both registration orders, three service shapes", {
      routes
    });

    // Real row-lock schedule: reservation commits first; takeover must re-read occupied state.
    const holder = await pool.connect();
    let pendingTakeover;
    try {
      await holder.query("BEGIN");
      await reserve(holder, a.binding);
      pendingTakeover = takeover(pool, "blocked_tab", "desk_blocked");
      pendingTakeover.catch(() => {});
      await until(
        async () =>
          Number(
            (
              await pool.query(`SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname='a04' AND wait_event_type='Lock' AND pid<>pg_backend_pid()`)
            ).rows[0].n
          ) > 0,
        "Takeover did not wait on the reservation transaction"
      );
      await holder.query("COMMIT");
      await assert.rejects(pendingTakeover, /Takeover refused: reserved/);
      assert.equal((await row()).generation, a.binding.generation);
      assert.equal((await pool.query("SELECT count(*) AS n FROM a04_bindings")).rows[0].n, "1");
      await pool.query("UPDATE a04_desk SET slot='idle',operation=NULL WHERE agent=1");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    await pass("A04.2/A04.3 reservation commits first; waiting takeover revalidates and rolls back");
    report.reservationFirst = {
      desk: await row(),
      bindings: (await pool.query("SELECT * FROM a04_bindings")).rows
    };

    // Pause an old verification after its real FS lookup, then commit takeover on another PG connection.
    let release;
    let captured;
    const capturedPromise = new Promise((resolve) => {
      captured = resolve;
    });
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const oldVerification = verify(pool, a.binding, lookup, async () => {
      captured();
      await barrier;
    });
    await capturedPromise;
    let unlockTakeover;
    let takeoverLocked;
    const takeoverLock = new Promise((resolve) => {
      takeoverLocked = resolve;
    });
    const takeoverRelease = new Promise((resolve) => {
      unlockTakeover = resolve;
    });
    const takeoverB = takeover(pool, "tab_b", b.username, async () => {
      takeoverLocked();
      await takeoverRelease;
    });
    await takeoverLock;
    const oldReserve = reserve(pool, a.binding);
    oldReserve.catch(() => {});
    await until(
      async () =>
        Number(
          (
            await pool.query(`SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname='a04' AND wait_event_type='Lock' AND pid<>pg_backend_pid()`)
          ).rows[0].n
        ) > 0,
      "Old reservation did not wait on takeover"
    );
    unlockTakeover();
    b.binding = await takeoverB;
    await assert.rejects(oldReserve, /unavailable/);
    assert.equal((await row()).ready, false);
    await assert.rejects(reserve(pool, b.binding), /unavailable/);
    report.takeoverFirst = { desk: await row(), oldReservationRejected: true };
    release();
    assert.equal(await oldVerification, null);
    assert.equal((await heartbeat(pool, a.binding)).rowCount, 0);
    assert.equal((await heartbeat(pool, a.binding, true)).rowCount, 0);
    assert.equal(await a.register(), 200);
    b.binding = await ready(b.binding);
    assert.equal(await a.register(0), 200);
    b.binding = await ready(b.binding);
    // An already queued command may reach a superseded endpoint; the receiver must reject it.
    assert.equal(await a.register(), 200);
    const late = await service(lastAuthorizedA, "delayed-old-generation", { stale: true });
    const reservedB = await reserve(pool, b.binding);
    const current = await service(reservedB, "inbound");
    await pass("A04.2 idle takeover fences old verification/heartbeat/close/unregister and delayed INVITE", {
      generation: b.binding.generation,
      rejectedOldUuid: late.uuid,
      currentUuid: current.uuid,
      destination: current.invite.destination
    });
    // Revoke only the obsolete identity. Never flush the shared agent or current username.
    const cleanupStart = Date.now();
    const packetsBeforeCleanup = b.packets;
    identities.splice(
      identities.findIndex((i) => i.username === a.username),
      1
    );
    await render(directory, identities);
    assert.match(await command("reloadxml"), /\+OK/);
    await command(`sofia profile a04-loopback flush_inbound_reg ${a.username}@a04.invalid`);
    await until(async () => (await lookup(a.username)).startsWith("error/"), "Obsolete registration leaked");
    const denied = await a.register();
    assert.ok([401, 403].includes(denied), "Revoked credentials registered again");
    await pool.query("UPDATE a04_bindings SET cleaned=true WHERE username=$1 AND revoked", [a.username]);
    const oldBinding = (await pool.query("SELECT * FROM a04_bindings WHERE username=$1", [a.username]))
      .rows[0];
    assert.ok(Date.now() <= oldBinding.cleanup_due.getTime(), "Obsolete cleanup missed takeover+5s deadline");
    assert.equal(await command(`uuid_exists ${current.uuid}`), "true");
    await until(() => b.packets > packetsBeforeCleanup + 3, "Cleanup interrupted new media");
    await heartbeat(pool, b.binding);
    b.binding = await ready(b.binding);
    assert.ok(Date.now() - cleanupStart < 5000, "Cleanup exceeded 5s lab budget");
    await pass("A04.2/A04.3 obsolete identity removed, registration flushed, refresh refused within 5s", {
      cleanupMs: Date.now() - cleanupStart,
      denied
    });
    await hangup(current.uuid);

    // Ambiguous same-session registration must clear readiness rather than fork or choose newest.
    const identityB = identities.find((i) => i.username === b.username);
    const duplicate = await sipClient({ ...identityB, source: "127.0.0.4", authorize: () => false });
    clients.push(duplicate);
    assert.equal(await duplicate.register(), 200);
    assert.equal((await verify(pool, b.binding, lookup)).ready, false);
    await assert.rejects(reserve(pool, b.binding), /unavailable/);
    assert.equal(await b.register(0), 200);
    assert.equal(
      (await verify(pool, b.binding, lookup)).ready,
      false,
      "Contact move cannot reuse generation"
    );
    assert.equal(await b.register(), 200);
    assert.equal(await duplicate.register(0), 200);
    b.binding = await ready(b.binding);
    await pass("A04.2 ambiguous or moved contact clears readiness and blocks sends");

    const preservation = [];
    for (const shape of ["inbound", "outbound", "transfer"]) {
      await heartbeat(pool, b.binding);
      b.binding = await ready(b.binding);
      const reserved = await reserve(pool, b.binding);
      const call = await service(reserved, shape);
      for (const slot of OCCUPIED) {
        await pool.query("UPDATE a04_desk SET slot=$1,expires=now()-interval '1 second' WHERE agent=1", [
          slot
        ]);
        const before = b.packets;
        await assert.rejects(
          takeover(pool, "intruder", `desk_refused_${slot}`),
          new RegExp(`Takeover refused: ${slot}`)
        );
        assert.equal((await row()).generation, b.binding.generation);
        assert.equal((await row()).slot, slot);
        assert.equal(await command(`uuid_exists ${call.uuid}`), "true");
        await until(() => b.packets > before + 2, "Existing media stopped");
        preservation.push({ shape, slot, uuid: call.uuid, heartbeatExpired: true, packetsAfter: b.packets });
      }
      await hangup(call.uuid);
    }
    await pass(
      "A04.3 all five occupied states refuse takeover after heartbeat expiry; same leg/RTP survives",
      { preservation }
    );

    for (const c of clients) assert.deepEqual(c.errors, []);
    await until(
      async () => /^0 total\./.test(await command("show channels count")),
      "Channel table did not converge to zero"
    );
    report.finalDesk = await row();
    report.bindings = (await pool.query("SELECT * FROM a04_bindings ORDER BY generation")).rows;
    assert.equal(report.finalDesk.slot, "idle");
    assert.equal(report.finalDesk.operation, null);
    assert.equal(report.bindings.length, 2, "Refused takeovers must not persist identities");
    // Complete lab teardown while the registrar is still inspectable; container cleanup follows.
    await heartbeat(pool, b.binding, true);
    await render(directory);
    assert.match(await command("reloadxml"), /\+OK/);
    await command(`sofia profile a04-loopback flush_inbound_reg ${b.username}@a04.invalid`);
    await until(
      async () => (await lookup(b.username)).startsWith("error/"),
      "Current lab registration leaked"
    );
    await pool.query("UPDATE a04_bindings SET revoked=true,cleaned=true");
    report.afterTeardown = {
      desk: await row(),
      registrations: await command("sofia status profile a04-loopback reg")
    };
    assert.match(report.afterTeardown.registrations, /Total items returned: 0\b/);
    report.invites = clients.map((c) => ({
      username: c.username,
      address: c.address,
      invites: c.invites,
      registrations: c.registrations,
      packets: c.packets
    }));
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.stack;
    throw error;
  } finally {
    report.events = esl?.events.map((event) =>
      Object.fromEntries(
        Object.entries(event).filter(([key]) =>
          [
            "event-name",
            "event-subclass",
            "user",
            "host",
            "contact",
            "expires",
            "event-date-timestamp",
            "unique-id",
            "channel-name",
            "hangup-cause",
            "job-uuid",
            "variable_sip_destination_url",
            "variable_sip_h_x-a04-session",
            "variable_sip_h_x-a04-generation",
            "variable_sip_h_x-a04-operation",
            "variable_sip_invite_failure_status"
          ].includes(key)
        )
      )
    );
    await save();
    for (const c of clients) c.close();
    esl?.close();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory] = process.argv.slice(2);
  assert.ok(directory?.startsWith("/tmp/outbound-a04."), "Only the disposable A04 run directory is allowed");
  if (mode === "render") await render(directory);
  else if (mode === "probe") await probe(directory);
  else throw new Error("Expected render or probe");
}
