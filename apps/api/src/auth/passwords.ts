import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const keyLength = 64;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derivedKey = (await scryptAsync(secret, salt, keyLength)) as Buffer;
  return `scrypt$${salt}$${derivedKey.toString("base64url")}`;
}

export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  const [algorithm, salt, encodedKey] = hash.split("$");
  if (algorithm !== "scrypt" || !salt || !encodedKey) {
    return false;
  }

  const expectedKey = Buffer.from(encodedKey, "base64url");
  const actualKey = (await scryptAsync(secret, salt, expectedKey.length)) as Buffer;
  return expectedKey.length === actualKey.length && timingSafeEqual(expectedKey, actualKey);
}

export function generateSecret(byteLength = 24): string {
  return randomBytes(byteLength).toString("base64url");
}
