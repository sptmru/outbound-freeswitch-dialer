import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const deployCommitScript = join(rootDirectory, "scripts", "deploy-commit.sh");

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

  try {
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
      env: {
        ...process.env,
        DEPLOYED_SHA_FILE: deployedShaFile,
        DEPLOY_ROOT_DIR: target
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(await readFile(deployedShaFile, "utf8"), `${firstSha}\n`);
    assert.equal(git(target, "rev-parse", "HEAD"), firstSha);
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
