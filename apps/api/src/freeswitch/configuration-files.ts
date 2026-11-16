import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export async function atomicConfigurationWrite(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

// The actual writer owns an OS flock. A suspended API whose PostgreSQL session
// disappears cannot overwrite a newer publisher: the replacement is busy until
// this writer exits, and no filesystem mutation is performed by the API process.
// The lock is never stolen based on time/mtime; process exit releases it.
export class LockedConfigurationWriter {
  private pending: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private dead = false;
  private exited: Promise<void>;
  private constructor(private child: ChildProcessWithoutNullStreams) {
    child.stderr.resume();
    child.stdin.on("error", () => {
      this.dead = true;
      this.pending?.reject(new Error("Configuration writer pipe closed"));
      this.pending = null;
    });
    this.exited = new Promise((resolve) =>
      child.once("exit", () => {
        this.dead = true;
        this.pending?.reject(new Error("Configuration file writer exited"));
        this.pending = null;
        resolve();
      })
    );
  }
  static async acquire(directory: string): Promise<LockedConfigurationWriter | null> {
    await mkdir(join(directory, "inbound"), { recursive: true });
    const child = spawn(
      "flock",
      [
        "-n",
        "-E",
        "75",
        "-F",
        join(directory, "inbound", "publisher.lock"),
        process.execPath,
        fileURLToPath(new URL("./inbound-config-writer.js", import.meta.url)),
        directory
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const writer = new LockedConfigurationWriter(child);
    const lines = createInterface({ input: child.stdout });
    let ready = false;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Configuration file lock acquisition timed out"));
      }, 5000);
      child.once("error", () => {
        clearTimeout(timeout);
        reject(new Error("Cannot start flock configuration writer"));
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (!ready) {
          if (code === 75) resolve(null);
          else reject(new Error("Configuration file writer failed to acquire lock"));
        }
      });
      lines.on("line", (line) => {
        let response;
        try {
          response = JSON.parse(line) as { ready?: boolean; error?: string };
        } catch {
          child.kill("SIGKILL");
          return;
        }
        if (response.ready) {
          ready = true;
          clearTimeout(timeout);
          resolve(writer);
          return;
        }
        const pending = writer.pending;
        writer.pending = null;
        if (response.error) pending?.reject(new Error(response.error));
        else pending?.resolve();
      });
    });
  }
  async write(path: string, value: string) {
    if (this.dead || this.pending) throw new Error("Configuration writer is unavailable");
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.stdin.write(JSON.stringify({ path, value }) + "\n", (error) => {
        if (error) {
          this.pending = null;
          reject(new Error("Configuration writer pipe closed"));
        }
      });
    });
  }
  async close() {
    this.child.stdin.end();
    await this.exited;
  }
}
