// Executed only by LockedConfigurationWriter under `flock -F`. Keeping the actual
// writes in the lock-owning process fences a suspended/dead API parent as well as
// an independently failed writer. No shell or user-controlled commands run here.
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { atomicConfigurationWrite } from "./configuration-files.js";
const directory = process.argv[2];
const allowed = new Set(
  [join(directory, "dialplan", "public", "00-inbound.xml"), join(directory, "inbound", "last-good.xml")].map(
    (p) => resolve(p)
  )
);
const input = createInterface({ input: process.stdin });
let work = Promise.resolve();
input.on("line", (line) => {
  work = work.then(async () => {
    try {
      const request = JSON.parse(line) as { path: string; value: string };
      if (
        !allowed.has(resolve(request.path)) ||
        typeof request.value !== "string" ||
        Buffer.byteLength(request.value) > 1024 * 1024
      )
        throw new Error("Invalid configuration writer request");
      await atomicConfigurationWrite(request.path, request.value);
      process.stdout.write('{"ok":true}\n');
    } catch {
      process.stdout.write(
        '{"error":"Atomic configuration file write failed; check generated-volume permissions and disk space"}\n'
      );
    }
  });
});
input.on("close", () => {
  void work.then(() => process.exit(0));
});
process.stdout.write('{"ready":true}\n');
