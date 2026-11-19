import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const maxBytes = 2048 * 4096;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const serviceDirectory = "/var/lib/outbound-dialer/ingress";

function journalFingerprint(path) {
  assert.ok(statSync(path).size <= maxBytes, "Ingress journal exceeds its storage bound");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare("pragma quick_check").get().quick_check, "ok", "Invalid ingress journal");
    const identity = db.prepare("select id from metadata").all();
    assert.equal(identity.length, 1, "Expected one journal identity");
    assert.match(identity[0].id, uuid);
    const records = db.prepare("select * from evidence order by rowid limit 129").all();
    assert.ok(records.length <= 128, "Ingress journal exceeds its record bound");
    for (const row of records) {
      const record = JSON.parse(row.record);
      assert.match(row.uuid, uuid);
      assert.equal(record.uuid, row.uuid);
      assert.equal(record.journalId, identity[0].id);
      assert.equal(record.sequence, row.sequence);
      assert.ok(Number.isSafeInteger(row.sequence) && row.sequence > 0);
      assert.ok(Number.isSafeInteger(row.ack) && row.ack >= 0 && row.ack <= row.sequence);
    }
    return createHash("sha256")
      .update(JSON.stringify([identity, records]))
      .digest("hex");
  } finally {
    db.close();
  }
}

function hasDatabase(path) {
  const exists = existsSync(path);
  assert.ok(
    exists || !["-journal", "-wal", "-shm"].some((suffix) => existsSync(path + suffix)),
    "Ingress journal sidecar exists without its database"
  );
  return exists;
}

function sync(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const [operation, argument] = process.argv.slice(process.argv[1]?.endsWith(".mjs") ? 2 : 1);
try {
  if (operation === "verify") {
    journalFingerprint(argument);
  } else {
    const socket = process.env.FREESWITCH_INGRESS_SOCKET || join(serviceDirectory, "agent.sock");
    const target = argument ?? resolve(dirname(socket), "ingress.sqlite");
    assert.ok(
      argument || target.startsWith(serviceDirectory + "/"),
      "Ingress socket is outside the journal volume"
    );
    const present = hasDatabase(target);
    if (operation === "snapshot") {
      if (present) {
        const scratch = mkdtempSync(join(tmpdir(), "outbound-ingress-"));
        try {
          const snapshot = join(scratch, "ingress.sqlite");
          const db = new DatabaseSync(target, { readOnly: true });
          try {
            db.exec("pragma busy_timeout=1000");
            db.prepare("vacuum into ?").run(snapshot);
          } finally {
            db.close();
          }
          journalFingerprint(snapshot);
          process.stdout.write(readFileSync(snapshot));
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    } else {
      assert.ok(["guard", "install"].includes(operation), "Unknown journal operation");
      const archive = readFileSync(0, { flag: "r" });
      assert.ok(archive.length <= maxBytes, "Archived ingress journal exceeds its storage bound");
      assert.ok(
        archive.length || !present,
        "Restore would separate the local ingress journal from its database"
      );
      if (archive.length) {
        if (operation === "install") mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const scratch = mkdtempSync(
          join(
            operation === "install" ? dirname(target) : tmpdir(),
            operation === "install" ? ".restore-ingress-" : "outbound-ingress-"
          )
        );
        try {
          const staged = join(scratch, "ingress.sqlite");
          writeFileSync(staged, archive, { mode: 0o600, flag: "wx" });
          const fingerprint = journalFingerprint(staged);
          if (present) {
            assert.equal(
              journalFingerprint(target),
              fingerprint,
              "Existing ingress journal differs from the archive"
            );
          } else if (operation === "install") {
            chmodSync(dirname(target), 0o700);
            sync(staged);
            linkSync(staged, target);
            sync(dirname(target));
          }
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    }
  }
} catch (error) {
  console.error("Ingress journal operation failed:", error.message.split("\n")[0]);
  process.exitCode = 1;
}
