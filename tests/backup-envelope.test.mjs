import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const envelopeScript = join(rootDirectory, "scripts", "backup-envelope.mjs");
const passphrase = "test-backup-passphrase-that-is-longer-than-32-characters";

test("ODBACKUP2 round-trips data and rejects a tampered ciphertext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-backup-envelope-"));
  const source = join(directory, "source.bin");
  const encrypted = join(directory, "backup.enc");
  const decrypted = join(directory, "decrypted.bin");
  const tampered = join(directory, "tampered.enc");
  const rejectedOutput = join(directory, "rejected.bin");
  const payload = Buffer.from("outbound-dialer backup payload\0with binary data\n", "utf8");

  try {
    await writeFile(source, payload);
    assertExecutionSucceeded(runEnvelope("encrypt", source, encrypted));
    assertExecutionSucceeded(runEnvelope("decrypt", encrypted, decrypted));
    assert.deepEqual(await readFile(decrypted), payload);

    const corrupted = await readFile(encrypted);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    await writeFile(tampered, corrupted);

    const result = runEnvelope("decrypt", tampered, rejectedOutput);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /authentication or decryption failed/i);
    await assert.rejects(readFile(rejectedOutput), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

function runEnvelope(operation, input, output) {
  return spawnSync(process.execPath, [envelopeScript, operation, input, output], {
    encoding: "utf8",
    env: { ...process.env, BACKUP_ENCRYPTION_PASSPHRASE: passphrase }
  });
}

function assertExecutionSucceeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
