import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  commitMetadata,
  DEFAULT_AGY_CLAUDE_MODEL,
  DEFAULT_AGY_GEMINI_MODEL,
  DEFAULT_CURSOR_MODEL,
  localReviewAdditionalPrompt,
  LOCAL_REVIEW_SCRUBBED_TOKEN_ENV,
  LOCAL_REVIEW_SUPPORTED_ENGINES,
  LOCAL_REVIEW_WEB_SEARCH_CONFIG,
  stripMarkdownFence,
} from "../dist/commit-sweeper.js";

const GIT = process.env.GIT_BIN ?? "git";
const CLI = fileURLToPath(new URL("../dist/commit-sweeper.js", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT, args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lr-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Test Author");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function runLocalReview(dir: string, args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [CLI, "local-review", "--target-dir", dir, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env },
  });
  return { status: result.status, out: `${result.stderr ?? ""}${result.stdout ?? ""}` };
}

// The local-review offline contract: commitMetadata(..., offline=true) must read
// only local git and never shell out to `gh`. Using an UNSUPPORTED repo slug proves
// it: a real gh api call against "example/unsupported-repo" would fail, so a passing
// run with populated local fields confirms gh was never invoked.
test("commitMetadata offline mode uses only local git and never contacts GitHub", () => {
  const dir = initRepo();
  try {
    const sha = git(dir, "rev-parse", "HEAD");
    const meta = commitMetadata(dir, "example/unsupported-repo", sha, true);

    assert.equal(meta.githubAuthor, "");
    assert.equal(meta.githubCommitter, "");
    assert.equal(meta.sha, sha);
    assert.equal(meta.authorName, "Test Author");
    assert.equal(meta.authorEmail, "test@example.com");
    assert.equal(meta.subject, "init");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review refuses a dirty working tree", () => {
  const dir = initRepo();
  try {
    writeFileSync(join(dir, "dirty.txt"), "x\n"); // untracked -> dirty
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/clawsweeper",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /working tree not clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review rejects an unsupported repository instead of a foreign-profile fallback", () => {
  const dir = initRepo();
  try {
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "nobody/not-a-real-profile",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /no review profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review rejects repositories covered only by a generic owner fallback", () => {
  const dir = initRepo();
  try {
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/example-tool",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /no review profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review exposes distinct current engines including AGY and cursor engines", () => {
  assert.deepEqual(LOCAL_REVIEW_SUPPORTED_ENGINES, [
    "codex",
    "claude",
    "agy-claude",
    "agy-gemini",
    "cursor",
  ]);
  assert.equal(DEFAULT_AGY_CLAUDE_MODEL, "Claude Sonnet 4.6 (Thinking)");
  assert.equal(DEFAULT_AGY_GEMINI_MODEL, "Gemini 3.1 Pro (High)");
  assert.equal(DEFAULT_CURSOR_MODEL, "auto");
});

test("local-review strips AGY preamble and fenced markdown report wrappers", () => {
  assert.equal(
    stripMarkdownFence(`The diff is small and reviewed.

\`\`\`md
---
sha: ${"a".repeat(40)}
result: findings
---

# Commit aaaaaaaa
\`\`\`
`),
    `---
sha: ${"a".repeat(40)}
result: findings
---

# Commit aaaaaaaa`,
  );
});

test("local-review rejects an unknown --engine", () => {
  const dir = initRepo();
  try {
    const base = git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "b.txt"), "2\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "second");
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/clawsweeper",
      "--base",
      base,
      "--engine",
      "bogus",
    ]);
    assert.equal(status, 1);
    assert.match(out, /--engine must be "codex", "claude", "agy-claude", "agy-gemini", "cursor"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review reports nothing to review when HEAD has no commits beyond base", () => {
  const dir = initRepo();
  try {
    const { status, out } = runLocalReview(dir, [
      "--target-repo",
      "openclaw/clawsweeper",
      "--base",
      "HEAD",
    ]);
    assert.equal(status, 1);
    assert.match(out, /no commits on HEAD beyond/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local-review scrubs both GitHub and GitHub Enterprise token aliases", () => {
  for (const v of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "COMMIT_SWEEPER_TARGET_GH_TOKEN",
    "CLAWSWEEPER_PROOF_INSPECTION_TOKEN",
  ]) {
    assert.ok(
      LOCAL_REVIEW_SCRUBBED_TOKEN_ENV.includes(v),
      `${v} must be in the offline scrub list`,
    );
  }
});

test("local-review disables web search and forbids network lookups in its prompt", () => {
  assert.equal(LOCAL_REVIEW_WEB_SEARCH_CONFIG, 'web_search="disabled"');
  const prompt = localReviewAdditionalPrompt("a".repeat(40), "b".repeat(40), "main");
  assert.match(prompt, /do not run gh/i);
  assert.match(prompt, /do not .*web search/i);
  assert.match(prompt, /do not .*network request/i);
  assert.match(prompt, /only the local checkout and git history/i);
});
