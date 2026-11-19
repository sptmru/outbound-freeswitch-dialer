import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const probes = [
  { id: "routing", suite: "d02-config", criteria: ["I02.1", "I02.4"] },
  { id: "ingress", suite: "d03-ingress", criteria: ["I02.2"] },
  {
    id: "acceptance-and-transfer",
    suite: "e02-acceptance",
    criteria: ["I02.1", "I02.4"],
    flags: { G02_TRANSFERS: "1", G04_SUPERVISION: "1" }
  },
  {
    id: "transfer-recordings",
    suite: "e02-acceptance",
    criteria: ["I02.1"],
    flags: { G02_TRANSFERS: "1", H02_RECORDINGS: "1" }
  },
  {
    id: "playback",
    suite: "d04-queue",
    criteria: ["I02.1"],
    flags: { F03_FALLBACK: "1" }
  },
  {
    id: "forwarding-and-recording",
    suite: "d04-queue",
    criteria: ["I02.1", "I02.4"],
    flags: { F04_FORWARDING: "1", H02_RECORDINGS: "1" }
  },
  {
    id: "browser-binding",
    suite: "d01-desk",
    criteria: ["I02.1", "I02.3"],
    args: ["--browser"],
    flags: { E04_SERVICE_INVITES: "1" },
    reportName: "browser-report.json"
  },
  {
    id: "lifecycle-recovery",
    suite: "e02-acceptance",
    criteria: ["I02.2", "I02.4"],
    flags: { H01_RECOVERY: "1" }
  },
  { id: "executor", suite: "c03-executor", criteria: ["I02.4"] }
];

// These flags also select reduced or different scenarios in standalone probes.
const inheritedFlags = [
  ...new Set(probes.flatMap((probe) => Object.keys(probe.flags ?? {}))),
  "F02_AUDIO",
  "F04_SCENARIO",
  "G01_TRANSFERS",
  "H01_MATRIX_ONLY",
  "D01_BROWSER_SMOKE"
];

function artifactDirectory(suite, output) {
  const task = suite.split("-")[0];
  const footer = new RegExp(
    `^${task.toUpperCase()} artifacts: (/tmp/outbound-${task}\\.[A-Za-z0-9]+)\\r?$`,
    "gm"
  );
  const matches = [...output.matchAll(footer)];
  return matches.length === 1 ? matches[0][1] : undefined;
}

async function readProbeEvidence(directory, reportName) {
  const [reportText, images, isolation, revision] = await Promise.all([
    readFile(join(directory, reportName), "utf8"),
    readFile(join(directory, "images.txt"), "utf8"),
    readFile(join(directory, "isolation.txt"), "utf8"),
    readFile(join(directory, "base-revision.txt"), "utf8")
  ]);
  const report = JSON.parse(reportText);
  if (typeof report.fs !== "string" || !report.fs.trim() || !report.scenarios?.length) {
    throw new Error("Probe report is missing FreeSWITCH version or scenario evidence");
  }
  return {
    status: report.status,
    boundary: report.boundary ?? report.media,
    freeSwitch: report.fs,
    chromium: report.chromium,
    postgres: report.database,
    images: images.trim().split("\n"),
    isolation: isolation.trim().split("\n"),
    revision: revision.trim(),
    scenarios: report.scenarios.map(({ name, status }) => ({ name, status }))
  };
}

async function runProbe(probe, directory, expectedRevision) {
  const { id, suite, criteria, args = [], flags = {}, reportName = "report.json" } = probe;
  const command = ["bash", `scripts/test-${suite}.sh`, ...args];
  const env = { ...process.env };
  for (const key of inheritedFlags) delete env[key];
  Object.assign(env, flags);
  const log = join(directory, `${id}.log`);
  const result = { id, criteria, command, flags, log, status: "failed" };
  try {
    const handle = await open(log, "wx", 0o600);
    try {
      const [exitCode, signal] = await new Promise((resolve, reject) => {
        const child = spawn(command[0], command.slice(1), {
          cwd: root,
          env,
          stdio: ["ignore", handle.fd, handle.fd]
        });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve([code, signal]));
      });
      Object.assign(result, { exitCode, signal });
    } finally {
      await handle.close();
    }
    result.artifacts = artifactDirectory(suite, await readFile(log, "utf8"));
    if (!result.artifacts) throw new Error("Missing or ambiguous probe artifact directory");
    result.report = join(result.artifacts, reportName);
    result.evidence = await readProbeEvidence(result.artifacts, reportName);
    const { status, scenarios, revision } = result.evidence;
    if (result.exitCode !== 0 || status !== "passed" || scenarios.some((s) => s.status !== "passed")) {
      throw new Error("Probe execution or scenario assertions failed");
    }
    if (revision !== expectedRevision) throw new Error("Probe ran on a different base revision");
    result.status = "passed";
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

const directory = await mkdtemp("/tmp/outbound-i02.");
const manifest = join(directory, "report.json");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const report = {
  revision,
  runnerSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  startedAt: new Date().toISOString(),
  node: process.version,
  scope: "Isolated probe results. A passing probe contributes evidence to its listed criteria.",
  status: "running",
  probes: []
};
const save = () => writeFile(manifest, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(`I02 report: ${manifest}`);
await save();
for (const probe of probes) {
  console.log(`RUN ${probe.id}`);
  const result = await runProbe(probe, directory, revision);
  report.probes.push(result);
  await save();
  console.log(
    `${result.status.toUpperCase()} ${probe.id} (${result.evidence?.scenarios.length ?? 0} scenarios)`
  );
}
report.finishedAt = new Date().toISOString();
report.status = report.probes.every((probe) => probe.status === "passed") ? "passed" : "failed";
await save();
if (report.status === "failed") process.exitCode = 1;
