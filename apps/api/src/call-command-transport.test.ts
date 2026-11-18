import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type pg from "pg";
import { createCommandDriver } from "./call-command-transport.js";
import type { DurableCommand } from "./call-executor.js";
const operation = (): DurableCommand => ({
  id: randomUUID(),
  call_id: randomUUID(),
  command_kind: "originate",
  generation: "1",
  command_uuid: randomUUID(),
  target_uuid: randomUUID(),
  request: {},
  state: "uncertain",
  deadline_at: new Date(Date.now() + 5000),
  result: null
});
async function server(command: (socket: net.Socket, frame: string) => void) {
  const sockets = new Set<net.Socket>();
  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.write("Content-Type: auth/request\n\n");
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      while (buffer.includes("\n\n")) {
        const end = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("auth ") || frame.startsWith("event plain "))
          socket.write("Content-Type: command/reply\nReply-Text: +OK accepted\n\n");
        else command(socket, frame);
      }
    });
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  return {
    port: (listener.address() as net.AddressInfo).port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => listener.close(() => r()));
    }
  };
}
test("C03 transport fixes Job-UUID, ignores ACK/unrelated jobs and verifies only the complete fragmented event", async () => {
  const op = operation();
  let sends = 0,
    verified = 0;
  const mock = await server((socket, frame) => {
    sends++;
    assert.equal(frame, `bgapi uuid_exists ${op.target_uuid}\nJob-UUID: ${op.command_uuid}`);
    socket.write(
      `Content-Type: command/reply\nReply-Text: +OK Job-UUID: ${op.command_uuid}\nJob-UUID: ${op.command_uuid}\n\n`
    );
    const event = `Event-Name: BACKGROUND_JOB\nJob-UUID: ${op.command_uuid}\nContent-Length: 4\n\n+OK\n`;
    const bytes = Buffer.from(
      `Content-Type: text/event-plain\nContent-Length: ${Buffer.byteLength(event)}\n\n${event}`
    );
    socket.write(bytes.subarray(0, bytes.length - 3));
    setTimeout(() => socket.write(bytes.subarray(bytes.length - 3)), 20);
  });
  try {
    const driver = createCommandDriver({
      host: "127.0.0.1",
      port: mock.port,
      password: "disposable",
      buildCommand: (o) => `uuid_exists ${o.target_uuid}`,
      verify: async (_o, job) => {
        verified++;
        assert.equal(job.jobUuid, op.command_uuid);
        assert.equal(job.body, "+OK\n");
        return { state: "succeeded", result: { job: job.jobUuid }, evidence: "mock job" };
      },
      reconcile: async () => null
    });
    const result = await driver.send(op, AbortSignal.timeout(1000), {} as pg.PoolClient);
    assert.equal(result?.state, "succeeded");
    assert.equal(verified, 1);
    assert.equal(sends, 1);
  } finally {
    await mock.close();
  }
});
test("C03 transport clean close, wrong Job-UUID and abort with active partial traffic settle without retries", async () => {
  for (const mode of ["close", "wrong-job", "partial"]) {
    let sends = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const mock = await server((socket) => {
      sends++;
      if (mode === "close") socket.end();
      if (mode === "wrong-job")
        socket.write(`Content-Type: command/reply\nReply-Text: +OK\nJob-UUID: ${randomUUID()}\n\n`);
      if (mode === "partial") timer = setInterval(() => socket.write("x"), 10);
    });
    try {
      const driver = createCommandDriver({
        host: "127.0.0.1",
        port: mock.port,
        password: "disposable",
        buildCommand: () => "uuid_exists fixture",
        verify: async () => {
          throw new Error("ACK must not be verified");
        },
        reconcile: async () => null
      });
      const began = performance.now();
      await assert.rejects(
        driver.send(operation(), AbortSignal.timeout(150), {} as pg.PoolClient),
        /peer|Job-UUID|aborted/
      );
      assert.ok(performance.now() - began < 1000);
      assert.equal(sends, 1);
    } finally {
      if (timer) clearInterval(timer);
      await mock.close();
    }
  }
});

test("H01 fenced transport arms the immutable operation on its leased connection before its one native frame", async () => {
  const op = operation(),
    boot = randomUUID();
  const frames: string[] = [];
  let armed = false;
  const mock = await server((socket, frame) => {
    frames.push(frame);
    if (frame.startsWith("api ")) {
      const body = frame.endsWith("core_uuid") ? boot : "/fixture/conf";
      socket.write(`Content-Type: api/response\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`);
    } else {
      assert.ok(armed);
      assert.equal(
        frame,
        `bgapi lua /fixture/conf/scripts/outbound-command.lua execute ${boot} ${op.command_uuid} ${op.id} uuid_exists ${op.target_uuid}\nJob-UUID: ${op.command_uuid}`
      );
      const event = `Event-Name: BACKGROUND_JOB\nJob-UUID: ${op.command_uuid}\n\ntrue`;
      socket.write(`Content-Type: text/event-plain\nContent-Length: ${Buffer.byteLength(event)}\n\n${event}`);
    }
  });
  try {
    const client = {
      async query(sql: string, params: string[]) {
        assert.match(sql, /insert into call_command_fences/);
        assert.deepEqual(params, [op.id, boot]);
        armed = true;
      }
    } as unknown as pg.PoolClient;
    const driver = createCommandDriver({
      host: "127.0.0.1",
      port: mock.port,
      password: "fixture",
      fenced: true,
      buildCommand: (o) => `uuid_exists ${o.target_uuid}`,
      verify: async () => ({ state: "succeeded", result: {}, evidence: "fixture" }),
      reconcile: async () => null
    });
    assert.equal(driver.protocol, "fs-fenced-v1");
    assert.equal((await driver.send(op, AbortSignal.timeout(1000), client))?.state, "succeeded");
    assert.equal(frames.length, 3);
  } finally {
    await mock.close();
  }
});

test("H01 abort while arming prevents a late SQL callback from sending any BGAPI frame", async () => {
  const boot = randomUUID();
  let release!: () => void, entered!: () => void;
  const arming = new Promise<void>((r) => (entered = r)),
    pending = new Promise<void>((r) => (release = r));
  const frames: string[] = [];
  const mock = await server((socket, frame) => {
    frames.push(frame);
    const body = frame.endsWith("core_uuid") ? boot : "/fixture/conf";
    socket.write(`Content-Type: api/response\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`);
  });
  try {
    const driver = createCommandDriver({
      host: "127.0.0.1",
      port: mock.port,
      password: "fixture",
      fenced: true,
      buildCommand: () => "uuid_exists fixture",
      verify: async () => null,
      reconcile: async () => null
    });
    const controller = new AbortController();
    const outcome = driver.send(operation(), controller.signal, {
      query() {
        entered();
        return pending;
      }
    } as unknown as pg.PoolClient);
    const rejected = assert.rejects(outcome, /aborted/);
    await arming;
    controller.abort();
    await rejected;
    release();
    await pending;
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(frames.filter((f) => f.startsWith("bgapi ")).length, 0);
  } finally {
    release?.();
    await mock.close();
  }
});
