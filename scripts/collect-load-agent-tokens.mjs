#!/usr/bin/env node

import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const config = await loadConfig(process.argv.slice(2), process.env);
const emails = await loadEmails(config.emailsFile);
await ensureOutputAvailable(config.tokensFile, config.overwrite);
const password = config.passwordFile
  ? await readPasswordFile(config.passwordFile)
  : await readSecret("Shared password for all listed test agents: ");

const tokens = [];
for (const [index, email] of emails.entries()) {
  process.stderr.write(`Logging in ${index + 1}/${emails.length}: ${email}\n`);
  const login = await loginAgent(email, password, config);
  tokens.push(login.token);

  if (index < emails.length - 1 && login.rateLimitRemaining === 0 && login.rateLimitResetAt) {
    const waitMilliseconds = Math.max(0, login.rateLimitResetAt - Date.now() + 1_000);
    if (waitMilliseconds > 0) {
      process.stderr.write(
        `Login rate limit reached; waiting ${Math.ceil(waitMilliseconds / 1000)}s for the next window\n`
      );
      await sleep(waitMilliseconds);
    }
  }
}

await writeTokensAtomically(config.tokensFile, tokens, config.overwrite);
process.stderr.write(`Collected ${tokens.length} token(s) in ${config.tokensFile}\n`);

async function loginAgent(email, currentPassword, currentConfig) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(`${currentConfig.baseUrl}/auth/login`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ email, password: currentPassword }),
      signal: AbortSignal.timeout(currentConfig.requestTimeoutMilliseconds)
    });

    if (response.status === 429 && attempt === 1) {
      const retryAfterSeconds = parsePositiveInteger(response.headers.get("retry-after"));
      await response.arrayBuffer();
      if (!retryAfterSeconds) {
        throw new Error(`Login rate limited for ${email} without a valid Retry-After header`);
      }
      process.stderr.write(`Login rate limited; retrying ${email} in ${retryAfterSeconds}s\n`);
      await sleep((retryAfterSeconds + 1) * 1000);
      continue;
    }

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      const message = typeof body?.message === "string" ? `: ${body.message}` : "";
      throw new Error(`Login failed for ${email} with HTTP ${response.status}${message}`);
    }
    if (
      typeof body?.token !== "string" ||
      !body.token ||
      body.user?.role !== "agent" ||
      body.user?.email?.toLowerCase() !== email.toLowerCase()
    ) {
      throw new Error(`Login response for ${email} did not contain the matching agent and token`);
    }

    return {
      token: body.token,
      rateLimitRemaining: parseNonNegativeInteger(response.headers.get("x-ratelimit-remaining")),
      rateLimitResetAt: parseEpochSeconds(response.headers.get("x-ratelimit-reset"))
    };
  }
  throw new Error(`Login failed for ${email}`);
}

async function loadConfig(argumentsList, environment) {
  if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
    await new Promise((resolvePromise) =>
      process.stdout.write(
        "Usage: LOAD_BASE_URL=https://host/api node scripts/collect-load-agent-tokens.mjs <emails-file> [tokens-file]\n",
        resolvePromise
      )
    );
    process.exit(0);
  }

  const emailsFile = argumentsList[0] || environment.LOAD_AGENT_EMAILS_FILE?.trim();
  const tokensFile = argumentsList[1] || environment.LOAD_AUTH_TOKENS_FILE?.trim();
  const baseUrl = environment.LOAD_BASE_URL?.trim().replace(/\/$/, "");
  if (!emailsFile) throw new Error("Pass an emails file or set LOAD_AGENT_EMAILS_FILE");
  if (!tokensFile) throw new Error("Pass a tokens output file or set LOAD_AUTH_TOKENS_FILE");
  if (!baseUrl) throw new Error("Set LOAD_BASE_URL; include /api for the public deployment");

  const parsedUrl = new URL(baseUrl);
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
    throw new Error("LOAD_BASE_URL must use http or https");
  }
  const approvedTarget = environment.LOAD_APPROVED_TARGET?.trim().replace(/\/$/, "");
  if (!isLoopback(parsedUrl.hostname) && approvedTarget !== baseUrl) {
    throw new Error(`Set LOAD_APPROVED_TARGET exactly to ${baseUrl}`);
  }

  return {
    baseUrl,
    emailsFile: resolve(emailsFile),
    tokensFile: resolve(tokensFile),
    passwordFile: environment.LOAD_AGENT_PASSWORD_FILE?.trim()
      ? resolve(environment.LOAD_AGENT_PASSWORD_FILE)
      : null,
    overwrite: environment.LOAD_TOKENS_OVERWRITE === "true",
    requestTimeoutMilliseconds: positiveInteger(environment.LOAD_REQUEST_TIMEOUT_MS, 10_000)
  };
}

async function loadEmails(path) {
  const contents = await readFile(path, "utf8");
  const values = contents
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && !value.startsWith("#"));
  const emails = [...new Set(values.map((value) => value.toLowerCase()))];
  if (!emails.length) throw new Error("The agent emails file is empty");
  const invalid = emails.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (invalid.length) throw new Error(`Invalid email(s): ${invalid.join(", ")}`);
  return emails;
}

async function readPasswordFile(path) {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("LOAD_AGENT_PASSWORD_FILE must not be accessible by group/other users; run chmod 600");
  }
  const password = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  if (!password) throw new Error("LOAD_AGENT_PASSWORD_FILE is empty");
  return password;
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Interactive password input requires a TTY; otherwise set LOAD_AGENT_PASSWORD_FILE");
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let secret = "";
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const onData = (chunk) => {
        for (const byte of chunk) {
          if (byte === 3) {
            cleanup();
            rejectPromise(new Error("Canceled"));
            return;
          }
          if (byte === 13 || byte === 10) {
            cleanup();
            if (!secret) rejectPromise(new Error("Password must not be empty"));
            else resolvePromise(secret);
            return;
          }
          if (byte === 127 || byte === 8) secret = secret.slice(0, -1);
          else secret += Buffer.from([byte]).toString("utf8");
        }
      };
      const cleanup = () => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write("\n");
      };
      process.stdin.on("data", onData);
    });
  } finally {
    secret = "";
  }
}

async function writeTokensAtomically(path, values, overwrite) {
  await ensureOutputAvailable(path, overwrite);

  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, `${values.join("\n")}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function ensureOutputAvailable(path, overwrite) {
  try {
    await stat(path);
    if (!overwrite) {
      throw new Error(`Token output already exists: ${path}; set LOAD_TOKENS_OVERWRITE=true to replace it`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Login endpoint returned non-JSON HTTP ${response.status}`);
  }
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInteger(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseEpochSeconds(value) {
  const seconds = parsePositiveInteger(value);
  return seconds ? seconds * 1000 : null;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("LOAD_REQUEST_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
