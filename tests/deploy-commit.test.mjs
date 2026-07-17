import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const deployCommitScript = join(rootDirectory, "scripts", "deploy-commit.sh");
const hostOperationLockEnvironmentKeys = [
  "OUTBOUND_DIALER_OPERATION_LOCK_FD",
  "OUTBOUND_DIALER_OPERATION_LOCK_FILE",
  "OUTBOUND_DIALER_OPERATION_LOCK_OWNER"
];

function isolatedHostOperationEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of hostOperationLockEnvironmentKeys) {
    delete environment[key];
  }
  return { ...environment, ...overrides };
}

function git(directory, ...arguments_) {
  const result = spawnSync("git", ["-C", directory, ...arguments_], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("remote deploy checks out and deploys the requested main-branch commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outbound-dialer-deploy-commit-"));
  const remote = join(directory, "remote.git");
  const source = join(directory, "source");
  const target = join(directory, "target");
  const deployedShaFile = join(directory, "deployed-sha");
  const toolPath = join(directory, "tools");
  const nvmDirectory = join(directory, "nvm");
  const nvmBin = join(directory, "nvm-bin");

  try {
    await mkdir(toolPath);
    await mkdir(nvmDirectory);
    await mkdir(nvmBin);
    for (const command of ["bash", "dirname", "env", "flock", "git", "mkdir"]) {
      await symlink(`/usr/bin/${command}`, join(toolPath, command));
    }
    await writeFile(
      join(nvmDirectory, "nvm.sh"),
      'nvm() {\n  [ "$1" = "use" ] || return 1\n  export PATH="$NVM_FAKE_BIN:$PATH"\n}\n'
    );
    await writeFile(
      join(nvmBin, "node"),
      '#!/bin/sh\ncase "$1" in\n  -p) echo 22 ;;\n  --version) echo v22.13.0 ;;\nesac\n'
    );
    await writeFile(join(nvmBin, "npm"), "#!/bin/sh\necho 10.9.2\n");
    await chmod(join(nvmBin, "node"), 0o755);
    await chmod(join(nvmBin, "npm"), 0o755);

    assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
    assert.equal(spawnSync("git", ["init", "-b", "main", source]).status, 0);
    git(source, "config", "user.name", "Deploy Test");
    git(source, "config", "user.email", "deploy@example.test");
    await mkdir(join(source, "scripts"));
    await writeFile(join(source, "release.txt"), "first\n");
    await writeFile(
      join(source, "scripts", "deploy.sh"),
      '#!/bin/sh\ngit rev-parse HEAD > "$DEPLOYED_SHA_FILE"\n'
    );
    await chmod(join(source, "scripts", "deploy.sh"), 0o755);
    git(source, "add", ".");
    git(source, "commit", "-m", "first release");
    const firstSha = git(source, "rev-parse", "HEAD");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "-u", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

    await writeFile(join(source, "release.txt"), "second\n");
    git(source, "add", "release.txt");
    git(source, "commit", "-m", "second release");
    git(source, "push", "origin", "main");

    assert.equal(spawnSync("git", ["clone", remote, target]).status, 0);
    const result = spawnSync("bash", [deployCommitScript, firstSha], {
      encoding: "utf8",
      env: isolatedHostOperationEnvironment({
        DEPLOYED_SHA_FILE: deployedShaFile,
        DEPLOY_ROOT_DIR: target,
        NVM_DIR: nvmDirectory,
        NVM_FAKE_BIN: nvmBin,
        PATH: toolPath
      })
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(deployedShaFile, "utf8"), `${firstSha}\n`);
    assert.equal(git(target, "rev-parse", "HEAD"), firstSha);
    assert.match(result.stdout, /Using v22\.13\.0 and npm 10\.9\.2/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("remote deploy rejects anything other than a full lowercase commit SHA", () => {
  const result = spawnSync("bash", [deployCommitScript, "main"], {
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected a full 40-character lowercase Git commit SHA/);
});
