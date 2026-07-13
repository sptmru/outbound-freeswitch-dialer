import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";

export function encryptSecret(config: AppConfig, value: string): string {
  const iv = randomBytes(12);
  const version = config.SIP_SECRET_WRITE_VERSION ?? "v1";
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(config, version), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${version}.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(config: AppConfig, value: string): string {
  const [version, encodedIv, encodedTag, encodedEncrypted] = value.split(".");
  if ((version !== "v1" && version !== "v2") || !encodedIv || !encodedTag || !encodedEncrypted) {
    throw new Error("unsupported encrypted secret format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(config, version),
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encodedEncrypted, "base64url")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

export function secretNeedsReencryption(config: AppConfig, value: string): boolean {
  return config.SIP_SECRET_WRITE_VERSION === "v2" && value.startsWith("v1.");
}

function encryptionKey(config: AppConfig, version: "v1" | "v2"): Buffer {
  const source = version === "v2" ? config.SIP_SECRET_ENCRYPTION_KEY : config.JWT_SECRET;
  if (!source) {
    throw new Error("SIP_SECRET_ENCRYPTION_KEY is required to decrypt v2 SIP credentials");
  }
  return createHash("sha256").update(source).digest();
}
