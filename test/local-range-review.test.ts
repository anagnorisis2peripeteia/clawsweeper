import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLocalRangeReviewForTest } from "../dist/clawsweeper.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lrr-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Range Tester");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

test("buildLocalRangeReview synthesizes a PR item + offline diff from the local range", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    // a ref at the base commit, so HEAD is one commit ahead of it
    git(dir, "branch", "base-ref");

    writeFileSync(join(dir, "feature.txt"), "hello world\n");
    git(dir, "add", "feature.txt");
    git(dir, "commit", "-q", "-m", "feat: add a feature\n\nthis is the body line");

    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");

    // synthetic item: a PR #0 titled from the commit subject, no GitHub involved
    assert.equal(result.item.number, 0);
    assert.equal(result.item.kind, "pull_request");
    assert.equal(result.item.title, "feat: add a feature");
    assert.equal(result.item.repo, "openclaw/clawsweeper");
    assert.equal(result.item.author, "Range Tester");
    assert.match(result.item.url, /^local:/);

    // synthetic context: body from the commit message, diff from `git diff`
    const issue = result.context.issue as { body: string };
    assert.match(issue.body, /this is the body line/);
    assert.deepEqual(result.context.comments, []);
    assert.deepEqual(result.context.timeline, []);
    const files = result.context.pullFiles as Array<{ filename: string; patch: string }>;
    assert.equal(files.length, 1);
    assert.equal(files[0]?.filename, "feature.txt");
    assert.match(files[0]?.patch ?? "", /\+hello world/);

    assert.equal(result.baseSha, git(dir, "rev-parse", "base-ref"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview throws when HEAD has no commits beyond base", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "only.txt"), "x\n");
    git(dir, "add", "only.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref"); // points at HEAD — empty range

    assert.throws(() => buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref"), {
      message: /no commits beyond/i,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
