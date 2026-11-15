import assert from "node:assert/strict";
import net from "node:net";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { until } from "./a05-media.mjs";

export const operationSchema = `CREATE TABLE a05_operations (
  lock_key integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid uuid NOT NULL UNIQUE, job uuid NOT NULL UNIQUE,
  generation integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','uncertain','released')),
  worker_pid integer, backend_pid integer,
  worker_reaped boolean NOT NULL DEFAULT false, transport_closed boolean NOT NULL DEFAULT false,
  sends integer NOT NULL DEFAULT 0 CHECK(sends BETWEEN 0 AND 1),
  job_done boolean NOT NULL DEFAULT false, terminal boolean NOT NULL DEFAULT false,
  CHECK(state <> 'released' OR (worker_reaped AND transport_closed AND (sends=0 OR (job_done AND terminal))))
)`;

export async function tryReuse(db, key) {
  return (
    (
      await db.query(
        `UPDATE a05_operations SET generation=generation+1,state='reserved',
    worker_pid=NULL,backend_pid=NULL,worker_reaped=false,transport_closed=false,sends=0,job_done=false,terminal=false
    WHERE lock_key=$1 AND state='released' RETURNING *`,
        [key]
      )
    ).rows[0] ?? null
  );
}

// Real TCP relay controls when bytes reach FS, independently of the worker/DB session.
// It is fault injection, not the proposed production executor or an authority gate.
export async function relay() {
  let incoming;
  let upstream;
  let pending;
  let buffer = "";
  let blocked = false;
  const sends = [];
  const server = net.createServer((socket) => {
    incoming = socket;
    upstream = net.createConnection({ host: "127.0.0.1", port: 8021 });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => {});
    upstream.on("data", (data) => {
      if (!blocked) socket.write(data);
    });
    socket.on("data", (data) => {
      buffer += data.toString();
      while (buffer.includes("\n\n")) {
        const end = buffer.indexOf("\n\n") + 2;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end);
        if (frame.startsWith("bgapi ")) {
          assert.equal(pending, undefined);
          pending = frame;
        } else upstream.write(frame);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    sends,
    get queued() {
      return Boolean(pending);
    },
    forward() {
      assert.ok(pending);
      blocked = true; // Simulate lost command response while independent observer retains events.
      sends.push({ at: new Date().toISOString(), command: pending.trim() });
      upstream.write(pending);
      pending = undefined;
    },
    async close() {
      incoming?.destroy();
      upstream?.destroy();
      pending = undefined;
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

export async function executorScenarios({ pool, directory, esl, command, target, pass }) {
  await pool.query(operationSchema);
  for (const mode of ["lock-lost-before-send", "delayed-send-after-lock-loss", "lost-response-after-send"]) {
    const uuid = randomUUID();
    const job = randomUUID();
    const row = (
      await pool.query("INSERT INTO a05_operations(uuid,job) VALUES($1,$2) RETURNING *", [uuid, job])
    ).rows[0];
    const transport = await relay();
    const messages = [];
    const output = [];
    const eventStart = esl.events.length;
    const inviteStart = target.invites.length;
    const endpoint = await command(`sofia_contact a04-loopback/${target.username}@a04.invalid`);
    assert.match(endpoint, /^sofia\/a04-loopback\/sip:desk_target@127\.0\.0\.4:\d+$/);
    const child = fork(
      new URL("./a05-executor-worker.mjs", import.meta.url),
      [
        JSON.stringify({
          directory,
          port: transport.port,
          key: row.lock_key,
          job,
          command: `originate {origination_uuid=${uuid},originate_timeout=3,hangup_after_bridge=false,park_after_bridge=true}${endpoint} &park()`
        })
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] }
    );
    child.on("message", (m) => messages.push(m));
    child.stdout.on("data", (d) => output.push(d.toString()));
    child.stderr.on("data", (d) => output.push(d.toString()));
    const exited = once(child, "exit");
    const snapshot = async () =>
      (await pool.query("SELECT * FROM a05_operations WHERE lock_key=$1", [row.lock_key])).rows[0];
    let replacement;
    try {
      const prepared = await until(
        () => messages.find((m) => m.type === "prepared"),
        "Executor not prepared"
      );
      if (mode !== "lock-lost-before-send") {
        child.send("continue");
        await until(() => transport.queued, "Command bytes not queued at relay");
        if (mode === "lost-response-after-send") {
          transport.forward();
          await until(
            () => esl.events.some((e) => e["event-name"] === "BACKGROUND_JOB" && e["job-uuid"] === job),
            "Actual FS job completion missing"
          );
          assert.equal(await command(`uuid_exists ${uuid}`), "true");
        }
      }
      child.kill("SIGSTOP");
      await until(
        async () => /^State:\s+T/m.test(await readFile(`/proc/${child.pid}/status`, "utf8")),
        "Worker not actually stopped"
      );
      assert.equal(
        (await pool.query("SELECT pg_terminate_backend($1) AS killed", [prepared.backend])).rows[0].killed,
        true
      );
      replacement = await pool.connect();
      await until(
        async () =>
          (await replacement.query("SELECT pg_try_advisory_lock(72203,$1) AS locked", [row.lock_key])).rows[0]
            .locked,
        "Replacement could not acquire released DB lock"
      );
      const unresolved = await snapshot();
      assert.equal(unresolved.state, "uncertain");
      await assert.rejects(
        replacement.query("UPDATE a05_operations SET state='released' WHERE lock_key=$1", [row.lock_key]),
        { code: "23514" }
      );
      assert.equal(await tryReuse(replacement, row.lock_key), null);
      assert.equal((await snapshot()).generation, 1);
      const absentAtTakeover = (await command(`uuid_exists ${uuid}`)) === "false";
      if (mode !== "lost-response-after-send") assert.equal(absentAtTakeover, true);
      if (mode === "delayed-send-after-lock-loss") {
        // Demonstrate why absence + the new advisory lock cannot release the slot.
        transport.forward();
        await until(
          () => esl.events.some((e) => e["event-name"] === "BACKGROUND_JOB" && e["job-uuid"] === job),
          "Delayed job never resolved"
        );
        assert.equal(await command(`uuid_exists ${uuid}`), "true");
        assert.equal(await tryReuse(replacement, row.lock_key), null);
      }
      child.kill("SIGCONT");
      if (mode === "lock-lost-before-send") child.send("continue");
      await until(
        () => messages.some((m) => m.type === "stopped"),
        "Old worker did not stop after lock/response failure",
        7000
      );
      const [code, signal] = await exited;
      assert.equal(code, 0, output.join(""));
      assert.equal(signal, null);
      await transport.close();
      const sent = transport.sends.length;
      assert.equal(sent, mode === "lock-lost-before-send" ? 0 : 1);
      if (sent) {
        await until(() => target.invites.length > inviteStart, "No actual target INVITE");
        assert.equal(target.invites.length - inviteStart, 1);
        assert.match(await command(`uuid_kill ${uuid} NORMAL_CLEARING`), /^\+OK/);
        await until(
          () =>
            esl.events
              .slice(eventStart)
              .some((e) => e["event-name"] === "CHANNEL_HANGUP_COMPLETE" && e["unique-id"] === uuid),
          "Terminal leg evidence missing"
        );
      } else assert.equal(target.invites.length, inviteStart);
      assert.equal(await command(`uuid_exists ${uuid}`), "false");
      assert.equal(
        esl.events
          .slice(eventStart)
          .filter((e) => e["event-name"] === "CHANNEL_CREATE" && e["unique-id"] === uuid).length,
        sent
      );
      // Only the independent coordinator can supply these evidence facts, after OS reap,
      // transport quiescence, exact BACKGROUND_JOB and terminal event reconciliation.
      await replacement.query(
        `UPDATE a05_operations SET worker_reaped=true,transport_closed=true,sends=$2,job_done=$3,terminal=$3 WHERE lock_key=$1`,
        [row.lock_key, sent, sent === 1]
      );
      assert.equal(
        (
          await replacement.query(
            "UPDATE a05_operations SET state='released' WHERE lock_key=$1 RETURNING *",
            [row.lock_key]
          )
        ).rowCount,
        1
      );
      const resolved = await snapshot();
      const reused = await tryReuse(replacement, row.lock_key);
      assert.equal(reused.generation, 2);
      await pass(`A05.2 ${mode}`, {
        uuid,
        job,
        absentAtTakeover,
        unresolved,
        resolved,
        reused,
        messages,
        sends: transport.sends,
        actualInvites: target.invites.length - inviteStart,
        processExit: { code, signal }
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        await exited;
      }
      if (replacement) {
        await replacement.query("SELECT pg_advisory_unlock(72203,$1)", [row.lock_key]);
        replacement.release();
      }
      await transport.close();
    }
  }
}
