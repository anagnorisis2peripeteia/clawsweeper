import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_SWEEPER = fileURLToPath(new URL("../dist/commit-sweeper.js", import.meta.url));
const CLAWSWEEPER = fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// A temp repo with a base-ref branch one commit behind HEAD, so the committed range
// merge-base(base-ref, HEAD)..HEAD is non-empty (something to review). Stub scripts and
// markers live in a SEPARATE tool dir — the review requires a clean working tree.
function initRepoWithRange(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "External Tester");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "branch", "base-ref");
  writeFileSync(join(dir, "a.txt"), "base\nfeature\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "feat: add a feature");
  return dir;
}

function writeStub(toolDir: string, name: string, body: string): string {
  const stub = join(toolDir, name);
  writeFileSync(stub, body);
  chmodSync(stub, 0o755);
  return stub;
}

// --- Surface A: markdown commit-sweeper local-review ------------------------------

test("local-review --engine external runs the named CLI and returns its markdown report", () => {
  const dir = initRepoWithRange("ext-a-");
  const toolDir = mkdtempSync(join(tmpdir(), "ext-a-tool-"));
  try {
    // stub read-only CLI: consume stdin, print a fixed markdown report (no real provider)
    const stub = writeStub(
      toolDir,
      "stub-markdown.sh",
      "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '---' 'engine: external-stub' '---' '# External stub review' 'looks fine'\n",
    );
    const result = spawnSync(
      process.execPath,
      [
        COMMIT_SWEEPER,
        "local-review",
        "--target-dir",
        dir,
        "--target-repo",
        "openclaw/clawsweeper",
        "--base",
        "base-ref",
        "--engine",
        "external",
        "--external-cmd",
        stub,
        "--external-args",
        "[]",
        "--external-prompt",
        "stdin",
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env }, timeout: 60000 },
    );
    assert.equal(result.status, 0, `expected success, got:\n${result.stderr}\n${result.stdout}`);
    // localReviewCommand prints the report path on stdout; the report holds the stub output.
    const reportPath = (result.stdout ?? "").trim().split("\n").pop() ?? "";
    assert.match(readFileSync(reportPath, "utf8"), /External stub review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(toolDir, { recursive: true, force: true });
  }
});

test("local-review --engine external rejects a missing --external-cmd", () => {
  const dir = initRepoWithRange("ext-a-nocmd-");
  try {
    const result = spawnSync(
      process.execPath,
      [
        COMMIT_SWEEPER,
        "local-review",
        "--target-dir",
        dir,
        "--target-repo",
        "openclaw/clawsweeper",
        "--base",
        "base-ref",
        "--engine",
        "external",
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env }, timeout: 60000 },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stderr}${result.stdout}`, /requires --external-cmd/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Surface B: structured review --local-range ----------------------------------

test("review --engine external is refused without --local-range (offline-only boundary)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ext-b-gate-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLAWSWEEPER,
        "review",
        "--local-only",
        "--target-repo",
        "openclaw/clawsweeper",
        "--target-dir",
        dir,
        "--engine",
        "external",
        "--external-cmd",
        "true",
      ],
      { encoding: "utf8", env: { ...process.env }, timeout: 60000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /only supported with --local-range/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review --local-range --engine external runs the CLI inside the offline envelope", () => {
  const dir = initRepoWithRange("ext-b-env-");
  const toolDir = mkdtempSync(join(tmpdir(), "ext-b-tool-"));
  const marker = join(toolDir, "stub-ran.txt");
  // Record CWD + the isolated gh config dir the external engine is handed — assert it ran
  // through the SAME offline envelope (checkout cwd + empty GH_CONFIG_DIR) as codex.
  const stub = writeStub(
    toolDir,
    "stub-env.sh",
    `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n%s\\n' "$PWD" "$GH_CONFIG_DIR" > "${marker}"\nprintf '# review\\nlgtm\\n'\n`,
  );
  try {
    spawnSync(
      process.execPath,
      [
        CLAWSWEEPER,
        "review",
        "--local-range",
        "--base",
        "base-ref",
        "--target-repo",
        "openclaw/clawsweeper",
        "--engine",
        "external",
        "--external-cmd",
        stub,
        "--external-args",
        "[]",
        "--external-prompt",
        "stdin",
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env }, timeout: 60000 },
    );
    const [cwd, ghConfigDir] = readFileSync(marker, "utf8").trim().split("\n");
    assert.equal(realpathSync(cwd ?? ""), realpathSync(dir), "engine runs in the checkout");
    assert.equal(basename(ghConfigDir ?? ""), ".gh-empty", "engine gets the isolated gh config");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(toolDir, { recursive: true, force: true });
  }
});

test("review --local-range --engine external bridges the engine's markdown into an advisory Decision", () => {
  const dir = initRepoWithRange("ext-b-adv-");
  const toolDir = mkdtempSync(join(tmpdir(), "ext-b-adv-tool-"));
  const artifactDir = mkdtempSync(join(tmpdir(), "ext-b-adv-art-"));
  const stub = writeStub(
    toolDir,
    "stub-md.sh",
    "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '# External advisory' 'MARKER-ADVISORY-OK'\n",
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLAWSWEEPER,
        "review",
        "--local-range",
        "--base",
        "base-ref",
        "--target-repo",
        "openclaw/clawsweeper",
        "--artifact-dir",
        artifactDir,
        "--engine",
        "external",
        "--external-cmd",
        stub,
        "--external-args",
        "[]",
        "--external-prompt",
        "stdin",
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env }, timeout: 60000 },
    );
    // advisory keep_open, and the engine's markdown surfaces in the rendered report
    assert.match(`${result.stderr}${result.stdout}`, /decision=keep_open/);
    const found = spawnSync("grep", ["-rl", "MARKER-ADVISORY-OK", artifactDir], {
      encoding: "utf8",
    });
    assert.equal(found.status, 0, "engine markdown should appear in the rendered report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(toolDir, { recursive: true, force: true });
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("review --local-range --engine external treats empty engine output as a FAILED review, not an advisory", () => {
  const dir = initRepoWithRange("ext-b-empty-");
  const toolDir = mkdtempSync(join(tmpdir(), "ext-b-empty-tool-"));
  const artifactDir = mkdtempSync(join(tmpdir(), "ext-b-empty-art-"));
  // stub exits 0 but prints NOTHING — a ran-but-said-nothing engine must not read as a pass.
  const stub = writeStub(toolDir, "stub-empty.sh", "#!/bin/sh\ncat >/dev/null\nexit 0\n");
  try {
    const result = spawnSync(
      process.execPath,
      [
        CLAWSWEEPER,
        "review",
        "--local-range",
        "--base",
        "base-ref",
        "--target-repo",
        "openclaw/clawsweeper",
        "--artifact-dir",
        artifactDir,
        "--engine",
        "external",
        "--external-cmd",
        stub,
        "--external-args",
        "[]",
        "--external-prompt",
        "stdin",
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env }, timeout: 60000 },
    );
    // The failure must PROPAGATE like a codex failure: the review command exits nonzero
    // (via the codexFailures counter), not just write failed-review content.
    assert.notEqual(
      result.status,
      0,
      "empty engine output must fail the review command (nonzero exit)",
    );
    const found = spawnSync("grep", ["-rl", "produced no review output", artifactDir], {
      encoding: "utf8",
    });
    assert.equal(found.status, 0, "empty engine output must produce a visible failed review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(toolDir, { recursive: true, force: true });
    rmSync(artifactDir, { recursive: true, force: true });
  }
});
