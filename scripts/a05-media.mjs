// Isolated UDP/PCMU endpoint and decoded audio assertions. No browser/provider proof.
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parse, digest } from "./a04-sip-client.mjs";

export async function until(fn, message, ms = 5000) {
  const deadline = Date.now() + ms;
  do {
    const result = await fn();
    if (result) return result;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(message);
}

export function decodeUlaw(byte) {
  const value = ~byte & 255;
  const sample = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
  return (value & 128 ? -1 : 1) * (sample - 132);
}

export function encodeUlaw(sample) {
  const sign = sample < 0 ? 128 : 0;
  let value = Math.min(32635, Math.abs(sample)) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1) exponent--;
  return ~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15)) & 255;
}

export function power(samples, frequency, rate = 8000) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    re += samples[i] * Math.cos((2 * Math.PI * frequency * i) / rate);
    im += samples[i] * Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return Math.hypot(re, im) / samples.length;
}

export function assertTone(samples, frequency) {
  assert.ok(samples.length >= 1600, "Less than 200 ms of decoded media");
  const level = power(samples, frequency);
  const noise = power(samples, 1337);
  assert.ok(level > 500 && level > noise * 5, `Missing ${frequency}Hz: ${level}, noise ${noise}`);
  return { frequency, samples: samples.length, level, noise };
}

export function decodeWav(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WAVE");
  let format;
  let data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + size);
    if (buffer.toString("ascii", offset, offset + 4) === "fmt ") format = chunk;
    if (buffer.toString("ascii", offset, offset + 4) === "data") data = chunk;
    offset += 8 + size + (size % 2);
  }
  assert.ok(format && data);
  assert.equal(format.readUInt16LE(0), 1, "Expected decoded PCM WAV");
  assert.equal(format.readUInt32LE(4), 8000);
  assert.equal(format.readUInt16LE(14), 16);
  const channels = format.readUInt16LE(2);
  const samples = [];
  for (let i = 0; i + channels * 2 <= data.length; i += channels * 2)
    samples.push(Array.from({ length: channels }, (_, c) => data.readInt16LE(i + c * 2)));
  return { channels, samples };
}

export async function endpoint({ username, password, source, frequency }) {
  const sip = dgram.createSocket("udp4");
  const rtp = dgram.createSocket("udp4");
  for (const socket of [sip, rtp])
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, source, resolve);
    });
  const address = `${source}:${sip.address().port}`;
  const contact = `<sip:${username}@${address}>`;
  const dialogs = new Map();
  const received = [];
  const invites = [];
  const errors = [];
  const responses = new Map();
  let sequence = 0;
  let rtpSequence = 0;
  let timestamp = 0;
  let target;
  const send = (raw, remote = { port: 5080, address: "127.0.0.1" }) =>
    sip.send(Buffer.from(raw), remote.port, remote.address);
  const sdp = [
    "v=0",
    `o=a05 1 1 IN IP4 ${source}`,
    "s=A05",
    `c=IN IP4 ${source}`,
    "t=0 0",
    `m=audio ${rtp.address().port} RTP/AVP 0`,
    "a=rtpmap:0 PCMU/8000",
    "a=sendrecv",
    ""
  ].join("\r\n");
  function media(body) {
    const ip = body.match(/c=IN IP4 ([^\r\n]+)/)?.[1];
    const port = Number(body.match(/m=audio (\d+)/)?.[1]);
    assert.equal(ip, "127.0.0.1");
    assert.ok(port >= 20000 && port <= 20040);
    target = { address: ip, port };
  }
  function request(method, uri, from, to, id, cseq, extra = [], body = "") {
    return [
      `${method} ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${address};branch=z9hG4bK${randomUUID()};rport`,
      "Max-Forwards: 70",
      `From: ${from}`,
      `To: ${to}`,
      `Call-ID: ${id}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: ${contact}`,
      ...extra,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body
    ].join("\r\n");
  }
  sip.on("message", (raw, remote) => {
    try {
      const msg = parse(raw.toString());
      const id = msg.headers["call-id"];
      if (msg.first.startsWith("SIP/2.0")) {
        const code = Number(msg.first.split(" ")[1]);
        if (code >= 200) responses.set(`${id}:${msg.headers.cseq}`, msg);
        if (code === 200 && msg.headers.cseq.endsWith(" INVITE")) {
          media(msg.body);
          const dialog = dialogs.get(id);
          dialog.to = msg.headers.to;
          dialog.uri = msg.headers.contact.match(/<([^>]+)>/)[1];
          send(request("ACK", dialog.uri, dialog.from, dialog.to, id, 1));
        }
        return;
      }
      const method = msg.first.split(" ")[0];
      if (method === "ACK") return;
      const to = msg.headers.to.includes(";tag=") ? msg.headers.to : `${msg.headers.to};tag=a05`;
      if (method === "INVITE") {
        media(msg.body);
        invites.push({ id, address });
        dialogs.set(id, { uri: msg.headers.contact.match(/<([^>]+)>/)[1], from: to, to: msg.headers.from });
      }
      if (method === "BYE") {
        target = null;
        dialogs.delete(id);
      }
      const body = method === "INVITE" ? sdp : "";
      send(
        [
          "SIP/2.0 200 OK",
          `Via: ${msg.headers.via}`,
          `From: ${msg.headers.from}`,
          `To: ${to}`,
          `Call-ID: ${id}`,
          `CSeq: ${msg.headers.cseq}`,
          `Contact: ${contact}`,
          ...(body ? ["Content-Type: application/sdp"] : []),
          `Content-Length: ${Buffer.byteLength(body)}`,
          "",
          body
        ].join("\r\n"),
        remote
      );
    } catch (error) {
      errors.push(error.message);
    }
  });
  rtp.on("message", (data) => {
    if (data.length >= 12 && data[0] === 128 && (data[1] & 127) === 0)
      received.push(...Array.from(data.subarray(12), decodeUlaw));
  });
  const timer = setInterval(() => {
    if (!target) return;
    const packet = Buffer.alloc(172);
    packet[0] = 128;
    packet.writeUInt16BE(rtpSequence++ & 65535, 2);
    packet.writeUInt32BE(timestamp >>> 0, 4);
    packet.writeUInt32BE(0xa0500001, 8);
    for (let i = 0; i < 160; i++)
      packet[12 + i] = encodeUlaw(6000 * Math.sin((2 * Math.PI * frequency * (timestamp + i)) / 8000));
    timestamp += 160;
    rtp.send(packet, target.port, target.address);
  }, 20);
  async function roundtrip(raw, id, cseq) {
    send(raw);
    return until(() => responses.get(`${id}:${cseq}`), `No SIP response for ${cseq}`);
  }
  return {
    username,
    address,
    received,
    invites,
    errors,
    async register() {
      const id = randomUUID();
      const uri = "sip:a04.invalid";
      const from = `<sip:${username}@a04.invalid>;tag=a05`;
      const make = (n, extra = []) =>
        request("REGISTER", uri, from, `<${uri}>`, id, n, ["Expires: 60", ...extra]);
      const challenge = await roundtrip(make(1), id, "1 REGISTER");
      assert.match(challenge.first, /401/);
      const auth = digest(challenge.headers["www-authenticate"], username, password, uri);
      assert.match((await roundtrip(make(2, [`Authorization: ${auth}`]), id, "2 REGISTER")).first, /200/);
    },
    async dial() {
      const id = randomUUID();
      const uri = "sip:customer@127.0.0.1:5080";
      const from = `<sip:${username}@${address}>;tag=a05`;
      const to = `<${uri}>`;
      dialogs.set(id, { from, to, uri });
      const result = await roundtrip(
        request("INVITE", uri, from, to, id, 1, ["Content-Type: application/sdp"], sdp),
        id,
        "1 INVITE"
      );
      assert.match(result.first, /200/);
      return id;
    },
    async bye() {
      for (const [id, d] of dialogs) {
        await roundtrip(request("BYE", d.uri, d.from, d.to, id, ++sequence + 2), id, `${sequence + 2} BYE`);
        dialogs.delete(id);
      }
      target = null;
    },
    close() {
      clearInterval(timer);
      sip.close();
      rtp.close();
    }
  };
}
