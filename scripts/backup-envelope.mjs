#!/usr/bin/env node

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, open, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const MAGIC = Buffer.from("ODBACKUP2\0", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;

const [operation, inputPath, outputPath] = process.argv.slice(2);
const passphrase = process.env.BACKUP_ENCRYPTION_PASSPHRASE;

if (!passphrase || passphrase.length < 32) {
  throw new Error("BACKUP_ENCRYPTION_PASSPHRASE must contain at least 32 characters");
}
if (!inputPath || !outputPath || !["encrypt", "decrypt"].includes(operation)) {
  throw new Error("Usage: backup-envelope.mjs <encrypt|decrypt> <input> <output>");
}

if (operation === "encrypt") {
  await encrypt(inputPath, outputPath, passphrase);
} else {
  await decrypt(inputPath, outputPath, passphrase);
}

async function encrypt(sourcePath, destinationPath, secret) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const key = await scrypt(secret, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);

  const destination = await open(destinationPath, "wx", 0o600);
  await destination.write(header);
  await destination.close();

  try {
    await pipeline(
      createReadStream(sourcePath),
      cipher,
      createWriteStream(destinationPath, { flags: "a", mode: 0o600 })
    );
    await appendFile(destinationPath, cipher.getAuthTag());
    await chmod(destinationPath, 0o600);
  } catch (error) {
    await unlink(destinationPath).catch(() => undefined);
    throw error;
  }
}

async function decrypt(sourcePath, destinationPath, secret) {
  const sourceStat = await stat(sourcePath);
  if (sourceStat.size <= HEADER_BYTES + TAG_BYTES) {
    throw new Error("Backup envelope is truncated");
  }

  const source = await open(sourcePath, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  await source.read(header, 0, header.length, 0);
  await source.read(tag, 0, tag.length, sourceStat.size - TAG_BYTES);
  await source.close();
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Backup is not an authenticated ODBACKUP2 envelope");
  }

  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + SALT_BYTES);
  const key = await scrypt(secret, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);

  try {
    await pipeline(
      createReadStream(sourcePath, { start: HEADER_BYTES, end: sourceStat.size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(destinationPath, { flags: "wx", mode: 0o600 })
    );
    await chmod(destinationPath, 0o600);
  } catch (error) {
    await unlink(destinationPath).catch(() => undefined);
    throw new Error(
      `Backup authentication or decryption failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
