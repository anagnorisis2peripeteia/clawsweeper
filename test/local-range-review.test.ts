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

    // a second changed path (modify) alongside the new file (add), so the
    // name-status parsing is exercised across multiple lines and both statuses.
    writeFileSync(join(dir, "feature.txt"), "hello world\n");
    writeFileSync(join(dir, "keep.txt"), "base\nmore\n");
    git(dir, "add", "feature.txt", "keep.txt");
    git(dir, "commit", "-q", "-m", "feat: add a feature\n\nthis is the body line");

    const headSha = git(dir, "rev-parse", "HEAD");
    const committedAt = git(dir, "log", "-1", "--format=%cI", "HEAD");
    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");

    // synthetic item: a PR #0 titled from the commit subject, no GitHub involved
    assert.equal(result.item.number, 0);
    assert.equal(result.item.kind, "pull_request");
    assert.equal(result.item.title, "feat: add a feature");
    assert.equal(result.item.repo, "openclaw/clawsweeper");
    assert.equal(result.item.author, "Range Tester");
    assert.equal(result.item.authorAssociation, "CONTRIBUTOR");
    assert.deepEqual(result.item.labels, []);
    assert.equal(result.item.url, `local:${headSha}`);
    assert.equal(result.item.createdAt, committedAt);
    assert.equal(result.item.updatedAt, committedAt);

    // synthetic context: body + issue mirror, diff from `git diff`
    const issue = result.context.issue as {
      body: string;
      title: string;
      state: string;
      user: { login: string };
      html_url: string;
    };
    assert.match(issue.body, /this is the body line/);
    assert.equal(issue.title, "feat: add a feature");
    assert.equal(issue.state, "open");
    assert.equal(issue.user.login, "Range Tester");
    assert.equal(issue.html_url, `local:${headSha}`);
    assert.deepEqual(result.context.comments, []);
    assert.deepEqual(result.context.timeline, []);

    const files = result.context.pullFiles as Array<{
      filename: string;
      status: string;
      patch: string;
    }>;
    assert.equal(files.length, 2);
    const byName = (name: string) => files.find((f) => f.filename === name);
    assert.equal(byName("feature.txt")?.status, "A");
    assert.match(byName("feature.txt")?.patch ?? "", /\+hello world/);
    assert.equal(byName("keep.txt")?.status, "M");
    assert.match(byName("keep.txt")?.patch ?? "", /\+more/);

    assert.deepEqual(result.context.counts, { comments: 0, timeline: 0, pullFiles: 2 });
    assert.equal(result.baseSha, git(dir, "rev-parse", "base-ref"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview falls back to a range title when the commit subject is empty", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");

    writeFileSync(join(dir, "f.txt"), "x\n");
    git(dir, "add", "f.txt");
    git(dir, "commit", "-q", "--allow-empty-message", "-m", ""); // no subject

    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");
    const baseSha = git(dir, "rev-parse", "base-ref");
    const headSha = git(dir, "rev-parse", "HEAD");
    // title = `local range ${baseSha.slice(0,8)}..${headSha.slice(0,8)}`
    assert.equal(result.item.title, `local range ${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}`);
    assert.equal(result.item.title, result.context.issue.title);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview defaults base to origin/main when baseRef is empty", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    const baseSha = git(dir, "rev-parse", "HEAD");
    // stand in for the remote-tracking ref the empty-base default resolves to
    git(dir, "update-ref", "refs/remotes/origin/main", baseSha);

    writeFileSync(join(dir, "feature.txt"), "hi\n");
    git(dir, "add", "feature.txt");
    git(dir, "commit", "-q", "-m", "feat: x");

    // empty baseRef → base falls back to "origin/main"
    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "");
    assert.equal(result.baseSha, baseSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview yields no pullFiles for a commit that changes nothing", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    git(dir, "commit", "-q", "--allow-empty", "-m", "empty: no file changes");

    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");
    assert.deepEqual(result.context.pullFiles, []);
    assert.equal(result.context.counts.pullFiles, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview handles renamed files (new path, non-empty patch, no tab leak)", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "old-name.txt"), "alpha\nbravo\ncharlie\ndelta\necho\n");
    git(dir, "add", "old-name.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    rmSync(join(dir, "old-name.txt"));
    writeFileSync(join(dir, "new-name.txt"), "alpha\nbravo\ncharlie\ndelta\nFOXTROT\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "rename old-name -> new-name with one edit");

    const result = buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref");
    const files = result.context.pullFiles as Array<{
      filename: string;
      status: string;
      patch: string;
    }>;
    // the new path is what surfaces — NOT the literal "old-name.txt\tnew-name.txt"
    assert.ok(!files.some((f) => f.filename.includes("\t")), "filename must not be tab-joined");
    const renamed = files.find((f) => f.filename === "new-name.txt");
    assert.ok(renamed, "renamed file should appear under its new path");
    assert.match(renamed?.status ?? "", /^R/);
    assert.match(renamed?.patch ?? "", /FOXTROT/); // patch resolved against the new path
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLocalRangeReview refuses a dirty working tree (committed-range contract)", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "keep.txt"), "base\n");
    git(dir, "add", "keep.txt");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "branch", "base-ref");
    writeFileSync(join(dir, "feature.txt"), "x\n");
    git(dir, "add", "feature.txt");
    git(dir, "commit", "-q", "-m", "feat: x");
    writeFileSync(join(dir, "uncommitted.txt"), "dirty\n"); // untracked → dirty tree

    assert.throws(() => buildLocalRangeReviewForTest(dir, "openclaw/clawsweeper", "base-ref"), {
      message: /not clean|commit or stash/i,
    });
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
