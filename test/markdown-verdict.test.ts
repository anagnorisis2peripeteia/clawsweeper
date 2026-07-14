import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  markdownVerdictInstructionForTest,
  parseMarkdownVerdictOutputForTest,
} from "../dist/clawsweeper.js";

const CLI = fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url));
const item = { repo: "owner/repo", number: 7 } as unknown as Parameters<
  typeof parseMarkdownVerdictOutputForTest
>[2];

function verdictBlock(overrides: Record<string, unknown> = {}): string {
  const base = {
    overall_tier: "A",
    proof_tier: "A",
    patch_tier: "B",
    real_behavior_proof_status: "sufficient",
    overall_correctness: "patch is correct",
    security_status: "cleared",
    findings: [],
  };
  return "```json\n" + JSON.stringify({ ...base, ...overrides }, null, 2) + "\n```";
}

test("instruction asks for markdown plus the exact verdict keys", () => {
  const text = markdownVerdictInstructionForTest();
  for (const key of [
    "overall_tier",
    "proof_tier",
    "patch_tier",
    "real_behavior_proof_status",
    "overall_correctness",
    "security_status",
    "findings",
  ]) {
    assert.match(text, new RegExp(key));
  }
  assert.match(text, /```json/);
  assert.match(text, /sufficient\|missing/);
  assert.match(text, /patch is correct\|patch is incorrect/);
});

test("valid markdown + verdict block yields a real structured decision", () => {
  const stdout = `## Review\nThe change looks solid; no blocking issues.\n\n${verdictBlock()}`;
  const { decision } = parseMarkdownVerdictOutputForTest(stdout, "agy-gemini", item);
  assert.equal(decision.prRating.overallTier, "A");
  assert.equal(decision.prRating.proofTier, "A");
  assert.equal(decision.prRating.patchTier, "B");
  assert.equal(decision.realBehaviorProof.status, "sufficient");
  assert.equal(decision.overallCorrectness, "patch is correct");
  assert.equal(decision.securityReview.status, "cleared");
  assert.equal(decision.reviewFindings.length, 0);
  assert.match(decision.summary, /no blocking issues/);
  assert.equal(decision.codexTerminalFailure, false);
  assert.equal(decision.decision, "keep_open");
  assert.match(decision.changeSummary, /markdown-verdict/i);
  // sufficient proof => the contributor need not act.
  assert.equal(decision.realBehaviorProof.needsContributorAction, false);
});

test("insufficient/missing proof status flags needsContributorAction", () => {
  for (const status of ["insufficient", "missing", "mock_only"]) {
    const stdout = `## Review\nproof is weak.\n\n${verdictBlock({ real_behavior_proof_status: status })}`;
    const { decision } = parseMarkdownVerdictOutputForTest(stdout, "agy-gemini", item);
    assert.equal(decision.realBehaviorProof.status, status);
    assert.equal(
      decision.realBehaviorProof.needsContributorAction,
      true,
      `${status} should need contributor action`,
    );
  }
  // ...and a sufficient/not_applicable status does not.
  for (const status of ["sufficient", "not_applicable"]) {
    const stdout = `## Review\nok.\n\n${verdictBlock({ real_behavior_proof_status: status })}`;
    const { decision } = parseMarkdownVerdictOutputForTest(stdout, "agy-gemini", item);
    assert.equal(decision.realBehaviorProof.needsContributorAction, false);
  }
});

test("object findings are mapped to review findings with priority (bug-B regression)", () => {
  const stdout = `## Review\nOne P1 issue.\n\n${verdictBlock({
    overall_tier: "C",
    patch_tier: "C",
    overall_correctness: "patch is incorrect",
    findings: [
      {
        title: "Null deref in parse()",
        body: "`x` can be undefined here.",
        priority: 1,
        file: "src/parse.ts",
        line_start: 12,
        line_end: 14,
      },
    ],
  })}`;
  const { decision } = parseMarkdownVerdictOutputForTest(stdout, "agy-gemini", item);
  assert.equal(decision.reviewFindings.length, 1);
  assert.equal(decision.reviewFindings[0].priority, 1);
  assert.equal(decision.reviewFindings[0].file, "src/parse.ts");
  assert.equal(decision.reviewFindings[0].lineStart, 12);
  assert.equal(decision.overallCorrectness, "patch is incorrect");
});

test("fail-closed: no json verdict block throws", () => {
  assert.throws(
    () => parseMarkdownVerdictOutputForTest("## Review\nLooks fine, shipping.", "agy-gemini", item),
    /no JSON verdict block/,
  );
});

test("fail-closed: an invalid enum value throws", () => {
  const stdout = `## Review\ntext\n\n${verdictBlock({ proof_tier: "Z" })}`;
  assert.throws(() => parseMarkdownVerdictOutputForTest(stdout, "agy-gemini", item), /proof_tier/);
});

test("fail-closed: verdict block with no markdown review throws", () => {
  assert.throws(
    () => parseMarkdownVerdictOutputForTest(verdictBlock(), "agy-gemini", item),
    /review is empty/,
  );
});

// Every fail-closed throw must be a NON-retryable terminal failure with the right message.
function assertTerminal(fn: () => unknown, msgRe: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "expected a throw");
  const err = caught as { message?: string; retryable?: boolean };
  assert.match(String(err.message), msgRe);
  // The CodexReviewError fail-closed throws must be non-retryable; the enum/shape validators
  // throw plain Errors (no retryable field), handled by the runner's own catch/retry.
  if (typeof err.retryable === "boolean") {
    assert.equal(err.retryable, false, "fail-closed CodexReviewError must be non-retryable");
  }
}

test("fail-closed errors are non-retryable across every branch", () => {
  assertTerminal(
    () => parseMarkdownVerdictOutputForTest("no block here", "agy-gemini", item),
    /no JSON verdict block/,
  );
  assertTerminal(
    () =>
      parseMarkdownVerdictOutputForTest(
        "## R\ntext\n\n```json\n{not valid json}\n```",
        "agy-gemini",
        item,
      ),
    /invalid JSON verdict block/,
  );
  assertTerminal(
    () =>
      parseMarkdownVerdictOutputForTest(
        `## R\ntext\n\n${verdictBlock({ proof_tier: "Z" })}`,
        "agy-gemini",
        item,
      ),
    /proof_tier/,
  );
  assertTerminal(
    () => parseMarkdownVerdictOutputForTest(verdictBlock(), "agy-gemini", item),
    /review is empty/,
  );
});

test("fail-closed: a verdict block missing a required key throws that key", () => {
  const partial = {
    overall_tier: "A",
    patch_tier: "B",
    real_behavior_proof_status: "sufficient",
    overall_correctness: "patch is correct",
    security_status: "cleared",
    findings: [],
  }; // proof_tier deliberately omitted
  const stdout = `## Review\ntext\n\n\`\`\`json\n${JSON.stringify(partial)}\n\`\`\``;
  assertTerminal(
    () => parseMarkdownVerdictOutputForTest(stdout, "agy-gemini", item),
    /missing required key: proof_tier/,
  );
});

test("a finding title longer than 80 chars is truncated to 80", () => {
  const longTitle = "T".repeat(120);
  const stdout = `## Review\nlong-title finding.\n\n${verdictBlock({
    findings: [
      { title: longTitle, body: "b", priority: 2, file: "f.ts", line_start: 1, line_end: 2 },
    ],
  })}`;
  const { decision } = parseMarkdownVerdictOutputForTest(stdout, "agy-gemini", item);
  assert.equal(decision.reviewFindings[0].title.length, 80);
});

for (const flag of ["--help", "-h"]) {
  test(`review ${flag} exits 0, prints usage, spawns no model process`, () => {
    const root = mkdtempSync(join(tmpdir(), "md-verdict-help-"));
    const artifactDir = join(root, "artifacts");
    try {
      const result = spawnSync(
        process.execPath,
        [CLI, "review", flag, "--artifact-dir", artifactDir],
        {
          encoding: "utf8",
          // Empty PATH prefix: if it tried to spawn a model CLI it would fail loudly.
          env: {
            ...process.env,
            PATH: `${join(root, "no-bin")}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      assert.equal(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /review \[options\]/i);
      assert.equal(existsSync(artifactDir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
