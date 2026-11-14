import assert from "node:assert/strict";
import { readFile, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { openEsl, invite } from "./a02-ingress-probe.mjs";
import { openJournal, schema, WAIT_US } from "./a03-ingress-journal.mjs";

async function render(directory, unavailable = false) {
  let xml = await readFile(
    new URL("../infra/freeswitch/prototypes/a02/freeswitch.xml.tpl", import.meta.url),
    "utf8"
  );
  xml = xml.replace(
    '<load module="mod_console"/>',
    '<load module="mod_console"/><load module="mod_lua"/><load module="mod_curl"/>'
  );
  xml = xml.replace(
    "__A02_ACTIONS__",
    `<action application="lua" data="/a02/ingress.lua${unavailable ? " unavailable" : ""}"/>`
  );
  await writeFile(join(directory, "freeswitch.xml"), xml);
}

async function until(fn, message, ms = 5000) {
  const deadline = Date.now() + ms;
  do {
    const value = await fn();
    if (value) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function probe(directory, fsContainer, pgContainer) {
  const report = { date: new Date().toISOString(), node: process.version, scenarios: [], commands: [] };
  const save = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const connections = [];
  let agent;
  const agentLog = await open(join(directory, "journal-agent.log"), "a");
  async function startAgent() {
    agent = spawn(
      process.execPath,
      [new URL("./a03-ingress-journal.mjs", import.meta.url).pathname, "serve", directory],
      { stdio: ["ignore", agentLog.fd, agentLog.fd] }
    );
    await until(async () => {
      try {
        return (await fetch("http://127.0.0.1:8093/health", { signal: AbortSignal.timeout(200) })).ok;
      } catch {
        return false;
      }
    }, "Journal agent not ready");
  }
  let esl;
  let client;
  const journal = openJournal(join(directory, "ingress.sqlite"));
  const rows = () => journal.prepare("SELECT * FROM ingress WHERE state<>0 ORDER BY arrived_us").all();
  const run = (command, args, expected = 0) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 20000 });
    report.commands.push({
      command,
      args,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    });
    assert.equal(result.status, expected, result.stderr || result.error?.message);
    return result;
  };
  async function ready() {
    await until(
      async () => {
        try {
          esl = await openEsl();
          return /a02-loopback.*RUNNING/.test((await esl.command("api sofia status")).body);
        } catch {
          esl?.close();
          return false;
        }
      },
      "FreeSWITCH not ready",
      15000
    );
    await esl.command("event plain ALL");
    await esl.command("log debug");
    connections.push({ events: esl.events, logs: esl.logs });
  }
  async function connectDb() {
    client = new pg.Client({ host: join(directory, "socket"), user: "postgres", database: "a03" });
    await client.connect();
  }
  async function live(uuid) {
    const body = (await esl.command(`api uuid_exists ${uuid}`)).body.trim();
    assert.ok(["true", "false"].includes(body), "Unknown ESL result cannot prove absence");
    return body === "true";
  }
  async function snapshot(row, name) {
    const evidence = [{ row, live: await live(row.uuid) }];
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify(evidence, null, 2) + "\n");
    return path;
  }
  function importer(path, fault) {
    return run(
      process.execPath,
      [
        new URL("./a03-ingress-journal.mjs", import.meta.url).pathname,
        "import",
        directory,
        path,
        ...(fault ? [fault] : [])
      ],
      fault ? 1 : 0
    );
  }
  const persisted = async (uuid) =>
    (await client.query("SELECT * FROM a03_calls WHERE ingress_uuid=$1", [uuid])).rows;
  function clearAcknowledged() {
    journal.exec("UPDATE ingress SET state=0, ack=0 WHERE state=2 AND ack=1");
  }
  async function start(options = {}) {
    const previous = new Set(rows().map((r) => r.uuid));
    let control;
    const result = invite({
      timeoutMs: 10000,
      ...options,
      control: (c) => {
        control = c;
      }
    });
    // Attach rejection immediately, then propagate it when awaiting the dialogue.
    result.catch(() => {});
    const row = await until(() => rows().find((r) => !previous.has(r.uuid)), "No durable ingress");
    assert.equal(await live(row.uuid), true);
    const dump = await until(async () => {
      const value = (await esl.command(`api uuid_dump ${row.uuid}`)).body;
      return /variable_a03_durable: true/.test(value) ? value : false;
    }, "Journal receipt was not acknowledged to FS");
    assert.ok(dump.includes(`variable_a03_arrived_us: ${row.arrived_us}`));
    return { row, result, cancel: () => control.cancel(), dump };
  }
  async function end(call) {
    call.cancel();
    const dialogue = await call.result;
    assert.equal(dialogue.final, 487);
    assert.equal(dialogue.rtp.length, 0);
    const terminal = await until(
      () => rows().find((r) => r.uuid === call.row.uuid && r.state === 2),
      "No terminal journal evidence"
    );
    assert.notEqual(terminal.cause, "NONE");
    return { terminal, dialogue };
  }
  async function pass(name, evidence) {
    report.scenarios.push({ name, status: "passed", ...evidence });
    await save();
    console.log(`PASS ${name}`);
  }
  try {
    await ready();
    await startAgent();
    report.version = (await esl.command("api version")).body.trim();
    await connectDb();
    await schema(client);
    for (const fault of ["before-insert", "after-commit"]) {
      const call = await start();
      const path = await snapshot(call.row, fault);
      importer(path, fault);
      assert.equal((await persisted(call.row.uuid)).length, fault === "before-insert" ? 0 : 1);
      assert.equal(rows().find((r) => r.uuid === call.row.uuid).ack, 0);
      // Independent OS processes model importer restart; replay the same capture twice.
      importer(path);
      importer(path);
      const [saved] = await persisted(call.row.uuid);
      assert.equal(Number(saved.arrived_us), call.row.arrived_us);
      assert.equal(Number(saved.deadline_us), call.row.arrived_us + WAIT_US);
      assert.equal(saved.terminal, false);
      assert.equal((await persisted(call.row.uuid)).length, 1);
      const { terminal, dialogue } = await end(call);
      const terminalPath = await snapshot(terminal, `${fault}-terminal`);
      importer(terminalPath);
      importer(path);
      importer(terminalPath);
      assert.equal((await persisted(call.row.uuid))[0].terminal, true);
      await pass(`A03.1 ${fault}`, { ingress: call.row, saved, dialogue });
      clearAcknowledged();
    }

    for (const order of ["terminal-first", "discovery-first"]) {
      const call = await start();
      // Actual DB stop, no importer process, and disconnected API ESL subscription.
      await client.end();
      esl.close();
      run("docker", ["stop", "--time", "2", pgContainer]);
      call.cancel();
      const dialogue = await call.result;
      assert.equal(dialogue.final, 487);
      assert.equal(dialogue.rtp.length, 0);
      const terminal = await until(
        () => rows().find((r) => r.uuid === call.row.uuid && r.state === 2),
        "Terminal evidence lost during outage"
      );
      assert.notEqual(terminal.cause, "NONE");
      run("docker", ["start", pgContainer]);
      await until(() => runReady(), "PostgreSQL not ready");
      await connectDb();
      await ready();
      // Discovery can see an old admission before it reads newer terminal evidence.
      const oldPath = await snapshot(call.row, `${order}-discovery`);
      const terminalPath = await snapshot(terminal, order);
      for (const path of order === "terminal-first"
        ? [terminalPath, oldPath, terminalPath]
        : [oldPath, terminalPath, oldPath])
        importer(path);
      const saved = await persisted(call.row.uuid);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].terminal, true);
      assert.equal(Number(saved[0].deadline_us), call.row.arrived_us + WAIT_US);
      await pass(`A03.2 ${order}`, { ingress: call.row, terminal, saved, dialogue });
      clearAcknowledged();
    }

    const interrupted = await start({ timeoutMs: 2500, allowNoFinal: true });
    esl.close();
    run("docker", ["kill", "--signal", "KILL", fsContainer]);
    run("docker", ["start", fsContainer]);
    await ready();
    assert.equal(await live(interrupted.row.uuid), false);
    const restartPath = await snapshot(interrupted.row, "fs-restart");
    importer(restartPath);
    importer(restartPath);
    const [recovered] = await persisted(interrupted.row.uuid);
    assert.equal(recovered.terminal, true);
    assert.equal(recovered.cause, "channel_absent_on_recovery");
    assert.equal(Number(recovered.arrived_us), interrupted.row.arrived_us);
    await interrupted.result;
    clearAcknowledged();
    await pass("A03.3 abrupt FS restart", { ingress: interrupted.row, recovered });

    const held = [];
    for (let i = 0; i < 4; i++) held.push(await start());
    const full = await invite({});
    assert.equal(full.final, 503);
    assert.ok(full.durationMs < 3000);
    assert.equal(full.rtp.length, 0);
    assert.equal(rows().length, 4);
    for (const call of held) {
      const { terminal } = await end(call);
      importer(await snapshot(terminal, `full-${call.row.slot}`));
    }
    clearAcknowledged();
    await pass("A03.3 journal exhausted", { capacity: 4, rejected: full });

    journal.exec("BEGIN IMMEDIATE");
    let locked;
    try {
      locked = await invite({});
    } finally {
      journal.exec("ROLLBACK");
    }
    assert.equal(locked.final, 503);
    assert.ok(locked.durationMs < 3000);
    assert.equal(locked.rtp.length, 0);
    assert.equal(rows().length, 0);
    await pass("A03.3 journal locked", { rejected: locked });

    // Frozen journal process: curl must return on its total timeout.
    process.kill(agent.pid, "SIGSTOP");
    let paused;
    try {
      paused = await invite({});
    } finally {
      process.kill(agent.pid, "SIGCONT");
    }
    assert.equal(paused.final, 503);
    assert.ok(paused.durationMs < 3000);
    assert.equal(paused.rtp.length, 0);
    await delay(50);
    assert.equal(rows().length, 0, "Timed-out request must not acquire a late journal slot");
    await pass("A03.3 journal agent stalled", { rejected: paused });

    // Lose terminal capture as well as API/ESL delivery: admission must survive.
    const agentOutage = await start();
    process.kill(agent.pid, "SIGSTOP");
    agentOutage.cancel();
    const outageDialogue = await agentOutage.result;
    assert.equal(outageDialogue.final, 487);
    assert.equal(outageDialogue.rtp.length, 0);
    await until(async () => !(await live(agentOutage.row.uuid)), "Channel remained live after caller CANCEL");
    // Agent restart retains a nonempty durable store, independently of importer/FS.
    agent.kill("SIGKILL");
    await new Promise((resolve) => agent.once("exit", resolve));
    await startAgent();
    assert.equal(rows().find((r) => r.uuid === agentOutage.row.uuid).state, 1);
    const outagePath = await snapshot(agentOutage.row, "journal-agent-outage");
    importer(outagePath);
    importer(outagePath);
    const [outageHistory] = await persisted(agentOutage.row.uuid);
    assert.equal(outageHistory.terminal, true);
    assert.equal(outageHistory.cause, "channel_absent_on_recovery");
    assert.equal(Number(outageHistory.arrived_us), agentOutage.row.arrived_us);
    clearAcknowledged();
    await pass("A03.3 journal agent restart", {
      ingress: agentOutage.row,
      recovered: outageHistory,
      dialogue: outageDialogue
    });

    await render(directory, true);
    assert.match((await esl.command("api reloadxml")).body, /\+OK/);
    const unavailable = await invite({});
    assert.equal(unavailable.final, 503);
    assert.ok(unavailable.durationMs < 3000);
    assert.equal(unavailable.rtp.length, 0);
    assert.equal(rows().length, 0);
    await pass("A03.3 journal unavailable", { rejected: unavailable });
    const channels = await until(async () => {
      const state = JSON.parse((await esl.command("api show channels as json")).body);
      return state.row_count === 0 ? state : false;
    }, "FS channels did not drain");
    report.finalChannels = channels;
    report.calls = (await client.query("SELECT * FROM a03_calls ORDER BY arrived_us")).rows;
    assert.equal(report.calls.length, 10);
    assert.ok(report.calls.every((r) => r.terminal));
    // No offers, commands, product migrations, or audio paths exist in the importer.
    report.finalJournal = rows();
    const allEvents = connections.flatMap((c) => c.events);
    assert.ok(!allEvents.some((e) => ["CHANNEL_ANSWER", "CHANNEL_BRIDGE"].includes(e["event-name"])));
    const applications = allEvents
      .filter((e) => e["event-name"] === "CHANNEL_EXECUTE")
      .map((e) => e.application);
    assert.ok(
      !applications.some((app) => ["answer", "pre_answer", "playback", "bridge", "originate"].includes(app))
    );
    report.observedApplications = [...new Set(applications)];
  } finally {
    report.connections = connections;
    report.eslEvents = esl?.events;
    report.eslLogs = esl?.logs;
    await save();
    agent?.kill("SIGKILL");
    await agentLog.close();
    journal.close();
    esl?.close();
    await client?.end().catch(() => {});
  }
  function runReady() {
    return (
      spawnSync(
        "docker",
        ["exec", pgContainer, "pg_isready", "-h", "/db-socket", "-U", "postgres", "-d", "a03"],
        { timeout: 2000 }
      ).status === 0
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, directory, fsContainer, pgContainer] = process.argv.slice(2);
  assert.ok(directory, "Usage: a03-ingress-probe.mjs render|probe DIRECTORY [FS_CONTAINER PG_CONTAINER]");
  if (action === "render") await render(directory);
  else if (action === "probe") await probe(directory, fsContainer, pgContainer);
  else throw new Error("Unknown A03 action");
}
