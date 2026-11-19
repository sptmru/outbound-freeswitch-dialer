import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
test("H04.3 journal backup refuses a mismatched or omitted journal and preserves pending bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "h04-journal-guard-"));
  const source = join(directory, "ingress.sqlite");
  const target = join(directory, "other", "ingress.sqlite");
  const stdout = join(directory, "stdout");
  const stderr = join(directory, "stderr");
  function tool(operation, file, input = "/dev/null") {
    const child = spawnSync(
      "bash",
      [
        "-c",
        'exec "$1" scripts/backup-ingress-journal.mjs "$2" "$3" < "$4" > "$5" 2> "$6"',
        "bash",
        process.execPath,
        operation,
        file,
        input,
        stdout,
        stderr
      ],
      { cwd: root, stdio: "ignore", timeout: 5000 }
    );
    return { status: child.status, stdout: readFileSync(stdout), stderr: readFileSync(stderr, "utf8") };
  }
  try {
    const id = randomUUID();
    const uuid = randomUUID();
    const db = new DatabaseSync(source);
    db.exec(`create table metadata(id text not null);
      create table evidence(uuid text primary key, sequence integer, ack integer, record text, admission text);`);
    db.prepare("insert into metadata values (?)").run(id);
    db.prepare("insert into evidence values(?,2,1,?,null)").run(
      uuid,
      JSON.stringify({ uuid, sequence: 2, journalId: id, terminalUs: 1 })
    );
    const snapshot = tool("snapshot", source);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.ok(snapshot.stdout.length > 0);
    db.close();
    const archive = join(directory, "archive.sqlite");
    writeFileSync(archive, snapshot.stdout);

    assert.equal(tool("guard", target, archive).status, 0);
    assert.equal(existsSync(target), false);
    assert.equal(tool("install", target, archive).status, 0);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(target), snapshot.stdout);
    assert.equal(tool("install", target, archive).status, 0);

    const restored = new DatabaseSync(target);
    restored.prepare("update evidence set ack=2 where uuid=?").run(uuid);
    restored.close();
    const newer = readFileSync(target);
    for (const operation of ["guard", "install"]) {
      const rejectOlder = tool(operation, target, archive);
      assert.equal(rejectOlder.status, 1);
      assert.match(rejectOlder.stderr, /Existing ingress journal differs from the archive/);
      const rejectOmitted = tool(operation, target);
      assert.equal(rejectOmitted.status, 1);
      assert.match(rejectOmitted.stderr, /separate the local ingress journal/);
      assert.deepEqual(readFileSync(target), newer);
    }
    const bad = join(directory, "bad.sqlite");
    writeFileSync(bad, Buffer.alloc(2048 * 4096 + 1));
    const oversize = tool("verify", bad);
    assert.equal(oversize.status, 1);
    assert.match(oversize.stderr, /storage bound/);

    const missingDb = join(directory, "missing.sqlite");
    writeFileSync(missingDb + "-journal", "orphan fixture");
    const missing = tool("snapshot", missingDb);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /sidecar exists without its database/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("H04.3 verification rejects a missing or unmarked snapshot and accepts pre-ingress archives", () => {
  const directory = mkdtempSync(join(tmpdir(), "h04-journal-metadata-"));
  try {
    const verify = () =>
      spawnSync(
        "bash",
        [
          "-c",
          'ROOT_DIR="$PWD"; source scripts/backup-ingress-journal.sh; validate_ingress_journal_bundle "$1"',
          "bash",
          directory
        ],
        { cwd: root }
      );
    writeFileSync(join(directory, "metadata.txt"), "postgres_database=fixture\n");
    assert.equal(verify().status, 0);
    writeFileSync(join(directory, "metadata.txt"), "ingress_journal=present\n");
    assert.match(verify().stderr.toString(), /requires an ingress journal snapshot/);
    writeFileSync(join(directory, "metadata.txt"), "ingress_journal=absent\n");
    writeFileSync(join(directory, "ingress.sqlite"), "");
    assert.match(verify().stderr.toString(), /without matching metadata/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("H04.3 restore guards ingress before PostgreSQL replacement and rollback preserves its named volume", () => {
  const readSource = (name) => readFileSync(new URL(`scripts/${name}.sh`, root), "utf8");
  const restore = readSource("restore");
  const stop = restore.indexOf("compose stop api freeswitch pcap-capture ingress-journal");
  const guard = restore.indexOf("run_ingress_journal_tool guard");
  const drop = restore.indexOf("compose exec -T postgres dropdb");
  const install = restore.indexOf("run_ingress_journal_tool install");
  const start = restore.indexOf("compose up -d --wait\n");
  assert.ok(0 < stop && stop < guard && guard < drop && drop < install && install < start);
  assert.doesNotMatch(readSource("rollback"), /\bdown\b|\bvolume\s+(?:rm|prune)\b/);
});
