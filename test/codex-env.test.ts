import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { codexEnv, reviewEngineEnv } from "../dist/codex-env.js";

test("review engine env disables nested Issue Loop hooks", () => {
  const originalEnv = process.env;
  try {
    process.env = { ...originalEnv, ISSUE_LOOP_ACTIVE: "0" };
    assert.equal(codexEnv().ISSUE_LOOP_ACTIVE, "0");
    assert.equal(reviewEngineEnv().ISSUE_LOOP_ACTIVE, "1");
  } finally {
    process.env = originalEnv;
  }
});

test("direct review launchers disable nested Issue Loop hooks", () => {
  const commitReviewSource = readFileSync("src/commit-sweeper.ts", "utf8");
  const clawsweeperSource = readFileSync("src/clawsweeper.ts", "utf8");

  assert.equal(
    commitReviewSource.match(/env:\s*reviewEngineEnv\(/g)?.length,
    5,
    "Codex, Claude, agy, Cursor, and OpenCode commit-review launches must use reviewEngineEnv",
  );
  assert.match(
    clawsweeperSource,
    /env:\s*\{\s*\.\.\.reviewEngineEnv\(\{\s*ghToken:/,
    "direct Codex reviews must use reviewEngineEnv",
  );
  assert.match(
    clawsweeperSource,
    /const engineEnv = reviewEngineEnv\(\);/,
    "direct Claude, agy, Cursor, and OpenCode reviews must use reviewEngineEnv",
  );
});
