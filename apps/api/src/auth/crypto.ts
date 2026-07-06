import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";

export function encryptSecret(config: AppConfig, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(config: AppConfig, value: string): string {
  const [version, encodedIv, encodedTag, encodedEncrypted] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedEncrypted) {
    throw new Error("unsupported encrypted secret format");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(config), Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encodedEncrypted, "base64url")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

function encryptionKey(config: AppConfig): Buffer {
  return createHash("sha256").update(config.JWT_SECRET).digest();
}
