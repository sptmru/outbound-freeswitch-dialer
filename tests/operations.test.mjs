import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const lockScript = join(rootDirectory, "scripts", "host-operation-lock.sh");
const cronPathScript = join(rootDirectory, "scripts", "cron-path.sh");
const certificateScript = join(rootDirectory, "scripts", "certificate-runtime.sh");
const runtimeScript = join(rootDirectory, "scripts", "verify-runtime-services.sh");

test("host operation lock rejects overlap and is inherited by nested maintenance scripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-operation-lock-"));
  const lockFile = join(directory, "operation.lock");
  const holder = spawn(
    "bash",
    [
      "-c",
      'source "$LOCK_SCRIPT"; acquire_host_operation_lock "$TEST_ROOT" holder; printf "ready\\n"; read -r _'
    ],
    {
      env: {
        ...process.env,
        LOCK_SCRIPT: lockScript,
        OUTBOUND_DIALER_OPERATION_LOCK_FILE: lockFile,
        TEST_ROOT: directory
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  try {
    await waitForOutput(holder.stdout, "ready\n");
    const overlapping = runLock(directory, lockFile, "overlapping");
    assert.notEqual(overlapping.status, 0);
    assert.match(overlapping.stderr, /another deploy, backup, restore, rollback, or certificate operation/);

    const spoofed = runLock(directory, lockFile, "spoofed", {
      OUTBOUND_DIALER_OPERATION_LOCK_FD: "1"
    });
    assert.notEqual(spoofed.status, 0);
    assert.match(spoofed.stderr, /lock does not match|Invalid inherited/);
  } finally {
    holder.stdin.end("done\n");
    await new Promise((resolvePromise) => holder.once("exit", resolvePromise));
    await rm(directory, { force: true, recursive: true });
  }

  const nestedDirectory = await mkdtemp(join(tmpdir(), "outbound-dialer-nested-lock-"));
  try {
    const nested = spawnSync(
      "bash",
      [
        "-c",
        'source "$LOCK_SCRIPT"; acquire_host_operation_lock "$TEST_ROOT" outer; bash -c \'source "$LOCK_SCRIPT"; acquire_host_operation_lock "$TEST_ROOT" nested\''
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LOCK_SCRIPT: lockScript,
          OUTBOUND_DIALER_OPERATION_LOCK_FILE: join(nestedDirectory, "operation.lock"),
          TEST_ROOT: nestedDirectory
        }
      }
    );
    assert.equal(nested.status, 0, nested.stderr || nested.stdout);
  } finally {
    await rm(nestedDirectory, { force: true, recursive: true });
  }
});

test("restore validates the dump and recreates a clean non-system database after readiness", async () => {
  const source = await readFile(join(rootDirectory, "scripts", "restore.sh"), "utf8");
  const databaseIdentityIndex = source.indexOf('[[ "${backup_source_database}" == "${POSTGRES_DB}" ]]');
  const stopIndex = source.indexOf("compose stop api freeswitch pcap-capture");
  const stageIndex = source.indexOf('recordings_stage="$(mktemp -d');
  const snapshotIndex = source.indexOf('recordings_snapshot="$(mktemp -d');
  const readyIndex = source.indexOf("compose up -d --wait postgres");
  const listIndex = source.indexOf("compose exec -T postgres pg_restore --list");
  const dropIndex = source.indexOf("compose exec -T postgres dropdb");
  const createIndex = source.indexOf("compose exec -T postgres createdb");
  const restoreIndex = source.indexOf("compose exec -T postgres pg_restore ", listIndex + 1);
  const activationIndex = source.indexOf('mv -T -- "${recordings_stage}" "${RECORDINGS_DIR}"');

  assert.ok(databaseIdentityIndex >= 0);
  assert.ok(readyIndex >= 0);
  assert.ok(
    readyIndex < listIndex && listIndex < dropIndex && dropIndex < createIndex && createIndex < restoreIndex
  );
  assert.ok(databaseIdentityIndex < dropIndex);
  assert.ok(stopIndex < stageIndex && stageIndex < snapshotIndex && snapshotIndex < dropIndex);
  assert.ok(restoreIndex < activationIndex);
  assert.match(source, /postgres \| template0 \| template1/);
  assert.match(source, /ALLOW_LEGACY_RESTORE_WITHOUT_DATABASE_MATCH/);
  assert.match(source, /--force/);
  assert.doesNotMatch(source.slice(restoreIndex), /--clean/);
  assert.match(source.slice(restoreIndex), /--single-transaction/);
});

test("cron PATH uses resolved absolute command directories and fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-cron-path-"));
  try {
    for (const command of ["aws", "bash", "crontab", "docker", "flock", "node", "stat"]) {
      const path = join(directory, command);
      await writeFile(path, "#!/bin/sh\nexit 0\n");
      await chmod(path, 0o755);
    }

    const resolved = spawnSync(
      "/bin/bash",
      ["-c", 'source "$CRON_PATH_SCRIPT"; build_cron_path bash crontab docker flock node stat aws'],
      {
        encoding: "utf8",
        env: { ...process.env, CRON_PATH_SCRIPT: cronPathScript, PATH: directory }
      }
    );
    assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
    assert.equal(
      resolved.stdout.trim(),
      `${directory}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
    );

    const missing = spawnSync(
      "/bin/bash",
      ["-c", 'source "$CRON_PATH_SCRIPT"; build_cron_path definitely-missing'],
      {
        encoding: "utf8",
        env: { ...process.env, CRON_PATH_SCRIPT: cronPathScript, PATH: directory }
      }
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing required cron command/);

    const installer = await readFile(join(rootDirectory, "scripts", "install-backup-cron.sh"), "utf8");
    assert.match(installer, /BACKUP_S3_URI[\s\S]*cron_commands\+=\(aws\)/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("CI hardened proxy test uses containment without publishing host ports", async () => {
  const proxyTest = await readFile(join(rootDirectory, "scripts", "test-proxy-runtime.sh"), "utf8");
  const workflow = await readFile(join(rootDirectory, ".github", "workflows", "ci.yml"), "utf8");

  assert.match(proxyTest, /--read-only/);
  assert.match(proxyTest, /--cap-drop ALL/);
  assert.match(proxyTest, /--health-cmd/);
  assert.doesNotMatch(proxyTest, /--publish/);
  assert.match(workflow, /bash scripts\/test-proxy-runtime\.sh/);
});

test("backup fails before success publication when a quiesced service cannot resume", async () => {
  const backup = await readFile(join(rootDirectory, "scripts", "backup.sh"), "utf8");

  assert.doesNotMatch(backup, /compose unpause "\$\{service\}"[^\n]*\|\| true/);
  assert.match(backup, /still_quiesced_services\+=\("\$\{service\}"\)/);
  assert.match(
    backup,
    /if ! resume_quiesced_services; then\s+echo "Backup snapshot was captured, but runtime services could not be resumed; refusing to publish a backup success"[^]*?exit 1\s+fi/
  );
});

test("certificate runtime reloads once per fingerprint and defers Coturn recreation for active calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-certificate-runtime-"));
  const operationsFile = join(directory, "operations");
  const harness = join(directory, "harness.sh");

  try {
    await writeFile(
      harness,
      `#!/usr/bin/env bash
set -euo pipefail
source "${certificateScript}"
compose() {
  if [[ "$1" == "exec" && "$3" == "proxy" && "$4" == "sh" ]]; then
    if [[ "$*" == *"s_client"* ]]; then
      printf '%s\\n' "\${FAKE_SERVED_FINGERPRINT:-\${FAKE_FINGERPRINT}}"
    else
      printf '%s\\n' "\${FAKE_FINGERPRINT}"
    fi
    return
  fi
  if [[ "$1" == "exec" && "$3" == "postgres" && "$4" == "psql" ]]; then
    if [[ "$*" == *"ops.call_start_paused"* ]]; then
      if [[ "$*" == *"values ('ops.call_start_paused', 'true'::jsonb"* ]]; then
        printf '%s\\n' "gate true" >> "\${OPERATIONS_FILE}"
      else
        printf '%s\\n' "gate false" >> "\${OPERATIONS_FILE}"
      fi
      return
    fi
    printf '%s\\n' "\${FAKE_ACTIVE_CALLS:-0}"
    return
  fi
  if [[ "$1" == "ps" && "$*" == *"coturn"* ]]; then
    printf '%s\\n' "ps coturn" >> "\${OPERATIONS_FILE}"
    printf '%s\\n' "coturn-container"
    return
  fi
  printf '%s\\n' "$*" >> "\${OPERATIONS_FILE}"
}
apply_certificate_runtime_if_changed "\${TEST_ROOT}"
`
    );
    await chmod(harness, 0o755);

    const first = runCertificateHarness(harness, directory, operationsFile, "fingerprint-a", "0");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const second = runCertificateHarness(harness, directory, operationsFile, "fingerprint-a", "0");
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /Certificate is unchanged/);

    const appliedOperations = (await readFile(operationsFile, "utf8")).trim().split("\n");
    assert.deepEqual(appliedOperations, [
      "gate true",
      "exec -T proxy /docker-entrypoint.d/20-render-outbound-dialer-proxy.sh",
      "exec -T proxy nginx -t",
      "exec -T proxy nginx -s reload",
      "up -d --wait --force-recreate coturn",
      "ps coturn",
      "gate false",
      "gate false"
    ]);

    const deferred = runCertificateHarness(harness, directory, operationsFile, "fingerprint-b", "2");
    assert.equal(deferred.status, 0, deferred.stderr || deferred.stdout);
    assert.match(deferred.stdout, /deferring proxy reload and Coturn recreation/);
    assert.deepEqual((await readFile(operationsFile, "utf8")).trim().split("\n").slice(-2), [
      "gate true",
      "gate false"
    ]);
    assert.equal(
      await readFile(join(directory, "logs", "applied-certificate.sha256"), "utf8"),
      "fingerprint-a\n"
    );

    const unverified = runCertificateHarness(
      harness,
      directory,
      operationsFile,
      "fingerprint-c",
      "0",
      "stale-served-fingerprint"
    );
    assert.notEqual(unverified.status, 0);
    assert.match(unverified.stderr, /does not serve the renewed certificate fingerprint/);
    assert.equal(
      await readFile(join(directory, "logs", "applied-certificate.sha256"), "utf8"),
      "fingerprint-a\n"
    );
    assert.equal((await readFile(operationsFile, "utf8")).trim().split("\n").at(-1), "gate false");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("runtime promotion check fails closed for a missing mandatory service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-runtime-services-"));
  const docker = join(directory, "docker");
  const environmentFile = join(directory, "environment");

  try {
    await writeFile(environmentFile, "# test\n");
    await writeFile(
      docker,
      `#!/bin/sh
if [ "$1" = compose ]; then
  for argument do service="$argument"; done
  [ "\${FAKE_MISSING_SERVICE:-}" = "$service" ] || printf 'container-%s\\n' "$service"
  exit 0
fi
if [ "$1" = inspect ]; then
  case "$3" in
    *State.Status*) printf 'running\\n' ;;
    *) printf 'healthy\\n' ;;
  esac
  exit 0
fi
exit 1
`
    );
    await chmod(docker, 0o755);
    const environment = {
      ...process.env,
      ENV_FILE: environmentFile,
      PATH: `${directory}:${process.env.PATH}`
    };
    const healthy = spawnSync("bash", [runtimeScript], { encoding: "utf8", env: environment });
    assert.equal(healthy.status, 0, healthy.stderr || healthy.stdout);

    const missing = spawnSync("bash", [runtimeScript], {
      encoding: "utf8",
      env: { ...environment, FAKE_MISSING_SERVICE: "web" }
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Mandatory runtime service web has no container/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

function runLock(directory, lockFile, operation, extraEnvironment = {}) {
  return spawnSync(
    "bash",
    ["-c", 'source "$LOCK_SCRIPT"; acquire_host_operation_lock "$TEST_ROOT" "$OPERATION"'],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LOCK_SCRIPT: lockScript,
        OPERATION: operation,
        OUTBOUND_DIALER_OPERATION_LOCK_FILE: lockFile,
        TEST_ROOT: directory,
        ...extraEnvironment
      }
    }
  );
}

function runCertificateHarness(
  harness,
  directory,
  operationsFile,
  fingerprint,
  activeCalls,
  servedFingerprint = fingerprint
) {
  return spawnSync("bash", [harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_ACTIVE_CALLS: activeCalls,
      FAKE_FINGERPRINT: fingerprint,
      FAKE_SERVED_FINGERPRINT: servedFingerprint,
      OPERATIONS_FILE: operationsFile,
      POSTGRES_DB: "outbound_dialer_test",
      POSTGRES_USER: "outbound_dialer",
      TEST_ROOT: directory
    }
  });
}

function waitForOutput(stream, expected) {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    const timeout = setTimeout(() => rejectPromise(new Error(`Timed out waiting for ${expected}`)), 5000);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
  });
}
