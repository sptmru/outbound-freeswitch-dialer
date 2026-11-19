import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { encodeUlaw } from "./a05-media.mjs";

export async function render(directory, mode = "unavailable") {
  assert.ok(["unavailable", "early-wait", "answered-wait"].includes(mode), "Unknown A02 fixture mode");
  const actions =
    mode === "unavailable"
      ? `<action application="sleep" data="750"/>
         <action application="respond" data="503 Admission unavailable"/>
         <action application="hangup" data="CALL_REJECTED"/>`
      : `<!-- SIMULATED admission, not durable or a deployable ingress protocol. -->
         <action application="${mode === "early-wait" ? "pre_answer" : "answer"}"/>
         <action application="playback" data="tone_stream://%(1000,0,440)"/>
         ${mode === "early-wait" ? '<action application="respond" data="480 Waiting ended before answer"/>' : ""}
         <action application="hangup" data="NORMAL_CLEARING"/>`;
  const template = await readFile(
    new URL("../infra/freeswitch/prototypes/a02/freeswitch.xml.tpl", import.meta.url),
    "utf8"
  );
  const xml = template.replace("__A02_ACTIONS__", actions);
  await writeFile(join(directory, `freeswitch-${mode}.xml`), xml);
  await writeFile(join(directory, "freeswitch.xml"), xml);
}

function parseHeaders(raw) {
  raw = raw.split(/\r?\n\r?\n/)[0];
  const lines = raw.split(/\r?\n/);
  const headers = {};
  for (const line of lines.slice(1)) {
    const split = line.indexOf(":");
    if (split > 0) headers[line.slice(0, split).toLowerCase()] = line.slice(split + 1).trim();
  }
  return { first: lines[0], headers };
}

export async function openEsl({ port = 8021 } = {}) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const events = [];
  const eventFrames = [];
  const logs = [];
  const frames = [];
  let buffer = Buffer.alloc(0);
  let failure;
  socket.on("error", (error) => (failure = error));
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const split = buffer.indexOf("\n\n");
      if (split < 0) break;
      const headerText = buffer.subarray(0, split).toString();
      const { headers } = parseHeaders(`frame\n${headerText}`);
      const length = Number(headers["content-length"] ?? 0);
      if (buffer.length < split + 2 + length) break;
      const body = buffer.subarray(split + 2, split + 2 + length).toString();
      buffer = buffer.subarray(split + 2 + length);
      const frame = { headers, body };
      if (headers["content-type"] === "text/event-plain") {
        const parsed = parseHeaders(`event\n${body}`).headers;
        const decoded = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, decodeURIComponent(v)])
        );
        events.push(decoded);
        const eventEnd = body.indexOf("\n\n");
        eventFrames.push({ headers: decoded, body: eventEnd < 0 ? "" : body.slice(eventEnd + 2) });
      } else if (headers["content-type"] === "log/data") logs.push(body);
      else frames.push(frame);
    }
  });
  async function frame() {
    const deadline = Date.now() + 5000;
    while (!frames.length && Date.now() < deadline && !failure) await delay(10);
    if (failure) throw failure;
    assert.ok(frames.length, "ESL response timeout");
    return frames.shift();
  }
  async function command(command) {
    socket.write(`${command}\n\n`);
    return frame();
  }
  try {
    await frame();
    assert.match((await command("auth a02-disposable-only")).headers["reply-text"], /^\+OK/);
    assert.match(
      (
        await command(
          "event plain CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE CHANNEL_DESTROY CUSTOM outbound_dialer::a02_validated"
        )
      ).headers["reply-text"],
      /^\+OK/
    );
    return {
      events,
      eventFrames,
      logs,
      command,
      get connected() {
        return !socket.destroyed && !failure;
      },
      close: () => socket.destroy()
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function bind(socket, host) {
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, host, resolve);
  });
}

export async function invite({
  port = 5080,
  source = "127.0.0.2",
  did = "+12025550100",
  forged = false,
  caller = "+12025550199",
  codec = "PCMU",
  timeoutMs = 5000,
  allowNoFinal = false,
  maxRtpPort = 20040,
  frequency,
  control
}) {
  const sip = dgram.createSocket("udp4");
  const rtp = dgram.createSocket("udp4");
  const messages = [];
  const packets = [];
  const callId = `${randomUUID()}@a02.invalid`;
  const spoof = "11111111-1111-4111-8111-111111111111";
  const started = Date.now();
  let audioTimer;
  let audioTarget;
  let sequence = 0,
    timestamp = 0;
  try {
    await bind(sip, source);
    await bind(rtp, source);
    if (frequency) {
      assert.equal(codec, "PCMU");
      audioTimer = setInterval(() => {
        if (!audioTarget) return;
        const packet = Buffer.alloc(172);
        packet[0] = 128;
        packet.writeUInt16BE(sequence++ & 65535, 2);
        packet.writeUInt32BE(timestamp >>> 0, 4);
        packet.writeUInt32BE(0xe0200001, 8);
        for (let i = 0; i < 160; i++)
          packet[12 + i] = encodeUlaw(6000 * Math.sin((2 * Math.PI * frequency * (timestamp + i)) / 8000));
        timestamp += 160;
        rtp.send(packet, audioTarget.port, audioTarget.host);
      }, 20);
    }
    rtp.on("message", (data) => {
      if (data.length >= 12 && data[0] >> 6 === 2)
        packets.push({ ms: Date.now() - started, type: data[1] & 127, payload: [...data.subarray(12)] });
    });
    const address = `${source}:${sip.address().port}`;
    const uri = `sip:${did}@127.0.0.1:${port}`;
    const branch = `z9hG4bK${randomUUID()}`;
    const from = `<sip:${caller}@a02.invalid>;tag=a02`;
    const to = `<${uri}>`;
    const payloadType = codec === "PCMA" ? 8 : 0;
    const sdp = [
      "v=0",
      "o=a02 1 1 IN IP4 " + source,
      "s=A02",
      "c=IN IP4 " + source,
      "t=0 0",
      `m=audio ${rtp.address().port} RTP/AVP ${payloadType}`,
      `a=rtpmap:${payloadType} ${codec}/8000`,
      "a=sendrecv",
      ""
    ].join("\r\n");
    function send(method, target, seq, targetTo, extra = [], body = "", transactionBranch = branch) {
      const data = [
        `${method} ${target} SIP/2.0`,
        `Via: SIP/2.0/UDP ${address};branch=${transactionBranch};rport`,
        `From: ${from}`,
        `To: ${targetTo}`,
        `Call-ID: ${callId}`,
        `CSeq: ${seq} ${method}`,
        `Contact: <sip:a02@${address}>`,
        "Max-Forwards: 70",
        ...extra,
        `Content-Length: ${Buffer.byteLength(body)}`,
        "",
        body
      ].join("\r\n");
      sip.send(data, port, "127.0.0.1");
    }
    let final;
    let bye = false;
    let dialogTarget = uri,
      dialogTo = to;
    sip.on("message", (raw, peer) => {
      const parsed = parseHeaders(raw.toString());
      messages.push({
        ms: Date.now() - started,
        first: parsed.first,
        headers: parsed.headers,
        body: raw.toString().split("\r\n\r\n").slice(1).join("\r\n\r\n")
      });
      const status = Number(parsed.first.split(" ")[1]);
      if (parsed.first.startsWith("SIP/2.0") && parsed.headers.cseq === "1 INVITE" && status >= 200) {
        final = status;
        const target = status < 300 ? (parsed.headers.contact?.match(/<([^>]+)>/)?.[1] ?? uri) : uri;
        if (status < 300) {
          dialogTarget = target;
          dialogTo = parsed.headers.to;
          if (frequency) {
            const body = messages.at(-1).body;
            const host = body.match(/c=IN IP4 ([^\r\n]+)/)?.[1];
            const mediaPort = Number(body.match(/m=audio (\d+)/)?.[1]);
            assert.equal(host, "127.0.0.1");
            assert.ok(mediaPort >= 20000 && mediaPort <= maxRtpPort);
            audioTarget = { host, port: mediaPort };
          }
        }
        send("ACK", target, 1, parsed.headers.to, [], "", status < 300 ? `z9hG4bK${randomUUID()}` : branch);
      }
      if (status === 200 && parsed.headers.cseq === "2 BYE") bye = true;
      if (parsed.first.startsWith("BYE ")) {
        bye = true;
        const response = [
          "SIP/2.0 200 OK",
          ...["via", "from", "to", "call-id", "cseq"].map((name) => `${name}: ${parsed.headers[name]}`),
          "Content-Length: 0",
          "",
          ""
        ].join("\r\n");
        sip.send(response, peer.port, peer.address);
      }
    });
    send(
      "INVITE",
      uri,
      1,
      to,
      [
        "Content-Type: application/sdp",
        ...(forged
          ? [
              `X-Outbound-Dialer-Call-ID: ${spoof}`,
              `X-Outbound-Dialer-Operation-ID: ${spoof}`,
              `X-Outbound-Dialer-Supervisor-Session-ID: ${spoof}`,
              `X-outbound_dialer_call_id: ${spoof}`,
              `variable_outbound_dialer_call_id: ${spoof}`,
              "X-A02-Trusted: true",
              "X-A02-Validated-DID: +12025550100",
              "P-Asserted-Identity: <sip:+12025550100@trusted.invalid>",
              "Diversion: <sip:+12025550100@trusted.invalid>"
            ]
          : [])
      ],
      sdp
    );
    control?.({
      packets: () => packets,
      cancel: () => send("CANCEL", uri, 1, to),
      hangup: () => send("BYE", dialogTarget, 2, dialogTo, [], "", `z9hG4bK${randomUUID()}`)
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !(final >= 300 || (final === 200 && bye))) await delay(10);
    assert.ok(final || allowNoFinal, "INVITE had no final response within deadline");
    return {
      callId,
      spoof,
      final,
      bye,
      messages,
      rtp: packets,
      audio: measureTone(packets, codec),
      durationMs: Date.now() - started,
      codec
    };
  } finally {
    if (audioTimer) clearInterval(audioTimer);
    sip.close();
    rtp.close();
  }
}

export function measureTone(packets, codec) {
  const samples = packets
    .flatMap((p) => p.payload)
    .map((byte) => {
      if (codec === "PCMA") {
        const a = byte ^ 0x55;
        const segment = (a >> 4) & 7;
        let value = (a & 15) << 4;
        value += segment === 0 ? 8 : 0x108;
        if (segment > 1) value <<= segment - 1;
        return a & 128 ? value : -value;
      }
      const u = ~byte & 255;
      const value = (((u & 15) << 3) + 0x84) << ((u >> 4) & 7);
      return u & 128 ? 0x84 - value : value - 0x84;
    });
  const crossings = samples.filter((sample, i) => i > 0 && samples[i - 1] <= 0 && sample > 0).length;
  return { samples: samples.length, frequencyHz: samples.length ? (crossings * 8000) / samples.length : 0 };
}

export function checkEvidence(
  result,
  events,
  { status, trusted = false, answered = false, earlyMedia = false }
) {
  assert.equal(result.final, status);
  assert.ok(result.durationMs < 3000, "Bounded fixture exceeded 3 seconds");
  const validated = events.filter((e) => e["event-subclass"] === "outbound_dialer::a02_validated");
  assert.equal(validated.length, trusted ? 1 : 0, "Trust/DID gate bypass or missing validated evidence");
  for (const event of events) {
    for (const key of ["call_id", "operation_id", "supervisor_session_id", "leg_type"]) {
      assert.ok(!event[`variable_outbound_dialer_${key}`], `Forged product authority: ${key}`);
    }
    assert.notEqual(event["event-name"], "CHANNEL_BRIDGE", "Fixture unexpectedly connected an agent");
    if (!answered) assert.notEqual(event["event-name"], "CHANNEL_ANSWER");
  }
  if (trusted) {
    assert.equal(validated[0]["a02-ingress-uuid"], validated[0]["unique-id"]);
    assert.notEqual(validated[0]["a02-ingress-uuid"], result.spoof);
    assert.equal(validated[0]["a02-did"], "+12025550100");
    assert.equal(validated[0]["a02-route-revision"], "fixture-v1");
  }
  if (answered || earlyMedia) {
    if (answered) {
      assert.ok(result.bye, "Answered fixture did not send BYE within 5 seconds");
      assert.equal(events.filter((e) => e["event-name"] === "CHANNEL_ANSWER").length, 1);
    }
    const answer = result.messages.find((m) => m.first.startsWith(`SIP/2.0 ${earlyMedia ? 183 : 200}`));
    assert.ok(answer, "Missing declared SIP media boundary");
    assert.ok(result.rtp.length >= 20, "No sustained waiting-audio RTP");
    assert.ok(result.rtp.every((p) => p.ms >= answer.ms && p.type === (result.codec === "PCMA" ? 8 : 0)));
    assert.ok(new Set(result.rtp.flatMap((p) => p.payload)).size > 8, "Waiting audio is constant/silent");
    assert.ok(
      result.audio.frequencyHz > 420 && result.audio.frequencyHz < 460,
      "Waiting audio is not the 440 Hz fixture"
    );
  } else assert.equal(result.rtp.length, 0, "Rejected pre-admission call emitted RTP");
}

async function probe(directory) {
  let esl;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      esl = await openEsl();
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(esl, "Disposable FreeSWITCH did not start");
  const report = { date: new Date().toISOString(), node: process.version, scenarios: [] };
  try {
    report.version = (await esl.command("api version")).body.trim();
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = (await esl.command("api sofia status")).body;
      if (/a02-loopback.*RUNNING/.test(status)) break;
      assert.ok(attempt < 99, `SIP profile did not become ready: ${status}`);
      await delay(100);
    }
    const scenarios = [
      { name: "trusted-unavailable", status: 503, trusted: true },
      { name: "trusted-no-plus", did: "12025550100", status: 503, trusted: true },
      { name: "untrusted-forged", source: "127.0.0.3", forged: true, status: 403 },
      { name: "unknown-forged", did: "+12025550999", forged: true, status: 404 },
      { name: "disabled", did: "+12025550101", status: 403 },
      { name: "trusted-forged", forged: true, status: 503, trusted: true },
      { name: "early-wait-pcmu", mode: "early-wait", status: 480, trusted: true, earlyMedia: true },
      { name: "answered-wait-pcmu", mode: "answered-wait", status: 200, trusted: true, answered: true },
      { name: "answered-wait-pcma", status: 200, trusted: true, answered: true, codec: "PCMA" }
    ];
    for (const scenario of scenarios) {
      if (scenario.mode) {
        await render(directory, scenario.mode);
        assert.match((await esl.command("api reloadxml")).body, /\+OK/);
      }
      const start = esl.events.length;
      const result = await invite(scenario);
      const record = { name: scenario.name, ...result, status: "checking" };
      report.scenarios.push(record);
      await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
      // Wait for explicit terminal evidence rather than assuming a command ACK cleaned up.
      const deadline = Date.now() + 2000;
      while (
        !esl.events.slice(start).some((e) => e["event-name"] === "CHANNEL_HANGUP_COMPLETE") &&
        Date.now() < deadline
      )
        await delay(10);
      const events = esl.events.slice(start);
      record.events = events;
      await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
      assert.equal(
        events.filter((e) => e["event-name"] === "CHANNEL_CREATE").length,
        1,
        "Unexpected extra media legs"
      );
      assert.equal(events.filter((e) => e["event-name"] === "CHANNEL_HANGUP_COMPLETE").length, 1);
      checkEvidence(result, events, scenario);
      let channels;
      const cleanupDeadline = Date.now() + 2000;
      do {
        channels = JSON.parse((await esl.command("api show channels as json")).body);
        if (channels.row_count === 0) break;
        await delay(10);
      } while (Date.now() < cleanupDeadline);
      assert.equal(channels.row_count, 0, "Channel leak after terminal evidence");
      Object.assign(record, { channels, status: "passed" });
      console.log(
        `PASS ${scenario.name}: SIP ${result.final}, ${result.durationMs}ms, RTP=${result.rtp.length}, channels=0`
      );
      await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    }
  } finally {
    await writeFile(join(directory, "events.json"), JSON.stringify(esl.events, null, 2) + "\n");
    esl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, directory] = process.argv.slice(2);
  assert.ok(directory, "Usage: a02-ingress-probe.mjs render|probe ARTIFACT_DIR");
  if (action === "render") await render(directory);
  else if (action === "probe") await probe(directory);
  else throw new Error("Unknown A02 action");
}
