// Real UDP SIP Digest REGISTER and SDP/RTP fixture; not browser/WebRTC proof.
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function parse(raw) {
  const [head, body = ""] = raw.split("\r\n\r\n");
  const [first, ...lines] = head.split("\r\n");
  const headers = Object.fromEntries(
    lines.map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
    })
  );
  return { first, headers, body };
}

const md5 = (value) => createHash("md5").update(value).digest("hex");
export function digest(challenge, username, password, uri, method = "REGISTER") {
  const fields = Object.fromEntries(
    [...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]])
  );
  assert.ok(fields.realm && fields.nonce);
  assert.ok(!fields.algorithm || fields.algorithm.toUpperCase() === "MD5");
  const cnonce = randomUUID().replaceAll("-", "");
  const ha1 = md5(`${username}:${fields.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = fields.qop ? "auth" : null;
  if (qop) assert.ok(fields.qop.split(",").includes("auth"));
  const response = md5(
    qop ? `${ha1}:${fields.nonce}:00000001:${cnonce}:auth:${ha2}` : `${ha1}:${fields.nonce}:${ha2}`
  );
  return (
    `Digest username="${username}", realm="${fields.realm}", nonce="${fields.nonce}", uri="${uri}", response="${response}", algorithm=MD5` +
    (fields.opaque ? `, opaque="${fields.opaque}"` : "") +
    (qop ? `, qop=auth, nc=00000001, cnonce="${cnonce}"` : "")
  );
}

export async function sipClient({ username, password, source, authorize }) {
  const sip = dgram.createSocket("udp4");
  const rtp = dgram.createSocket("udp4");
  const pending = new Map();
  const invites = [];
  const registrations = [];
  let packets = 0;
  const errors = [];
  const bind = (s) =>
    new Promise((resolve, reject) => {
      s.once("error", reject);
      s.bind(0, source, resolve);
    });
  await bind(sip);
  await bind(rtp);
  const address = `${source}:${sip.address().port}`;
  const contact = `<sip:${username}@${address}>`;
  let sequence = 0;
  const registerId = randomUUID();
  const send = (text, port, ip) => sip.send(Buffer.from(text), port, ip);
  rtp.on("message", (data) => {
    if (data.length > 12 && data[0] >> 6 === 2) packets++;
  });
  sip.on("message", (data, remote) => {
    void (async () => {
      const msg = parse(data.toString());
      if (msg.first.startsWith("SIP/2.0")) {
        if (Number(msg.first.split(" ")[1]) >= 200) pending.get(msg.headers.cseq)?.(msg);
        return;
      }
      const method = msg.first.split(" ")[0];
      if (method === "ACK") return;
      let code = 200;
      let body = "";
      if (method === "INVITE") {
        const accepted = await authorize(msg.headers);
        invites.push({ headers: msg.headers, destination: address, accepted });
        code = accepted ? 200 : 480;
        if (accepted)
          body = [
            "v=0",
            `o=a04 1 1 IN IP4 ${source}`,
            "s=A04",
            `c=IN IP4 ${source}`,
            "t=0 0",
            `m=audio ${rtp.address().port} RTP/AVP 0`,
            "a=rtpmap:0 PCMU/8000",
            "a=sendrecv",
            ""
          ].join("\r\n");
      }
      const response = [
        `SIP/2.0 ${code} ${code === 200 ? "OK" : "Temporarily Unavailable"}`,
        `Via: ${msg.headers.via}`,
        `From: ${msg.headers.from}`,
        `To: ${msg.headers.to}${msg.headers.to.includes(";tag=") ? "" : ";tag=a04"}`,
        `Call-ID: ${msg.headers["call-id"]}`,
        `CSeq: ${msg.headers.cseq}`,
        `Contact: ${contact}`,
        ...(body ? ["Content-Type: application/sdp"] : []),
        `Content-Length: ${Buffer.byteLength(body)}`,
        "",
        body
      ].join("\r\n");
      send(response, remote.port, remote.address);
    })().catch((error) => errors.push(error.message));
  });
  async function request(expires, authorization) {
    const cseq = `${++sequence} REGISTER`;
    const uri = "sip:a04.invalid";
    const message = [
      `REGISTER ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP ${address};branch=z9hG4bK${randomUUID()};rport`,
      "Max-Forwards: 70",
      `From: <sip:${username}@a04.invalid>;tag=a04`,
      `To: <sip:${username}@a04.invalid>`,
      `Call-ID: ${registerId}`,
      `CSeq: ${cseq}`,
      `Contact: ${contact}`,
      `Expires: ${expires}`,
      ...(authorization ? [`Authorization: ${authorization}`] : []),
      "Content-Length: 0",
      "",
      ""
    ].join("\r\n");
    let response;
    pending.set(cseq, (r) => {
      response = r;
    });
    try {
      // Bounded transaction retransmission, same CSeq/branch, no success masking.
      for (let i = 0; i < 3 && !response; i++) {
        send(message, 5080, "127.0.0.1");
        const deadline = Date.now() + 700;
        while (!response && Date.now() < deadline) await delay(10);
      }
      assert.ok(response, "REGISTER response timeout");
      return response;
    } finally {
      pending.delete(cseq);
    }
  }
  return {
    username,
    address,
    invites,
    registrations,
    errors,
    get packets() {
      return packets;
    },
    async register(expires = 30) {
      const challenge = await request(expires);
      assert.match(challenge.first, /^SIP\/2.0 401/);
      const response = await request(
        expires,
        digest(challenge.headers["www-authenticate"], username, password, "sip:a04.invalid")
      );
      const status = Number(response.first.split(" ")[1]);
      registrations.push({ expires, status, challenge: 401, address });
      return status;
    },
    close() {
      sip.close();
      rtp.close();
    }
  };
}
