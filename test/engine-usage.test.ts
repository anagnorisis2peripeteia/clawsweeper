import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectEngineExhaustion,
  engineUsageStatus,
  recordEngineExhausted,
} from "../dist/engine-usage.js";

const NOW = Date.parse("2026-06-24T20:15:00.000Z");

// Real limit strings captured from each engine.
const AGY =
  "E0624 RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h38m2s.";
const CODEX =
  "ERROR: You've hit your usage limit. Upgrade to Pro... try again at Jun 26th, 2026 3:16 PM.";
const CURSOR =
  "ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage.";

test("detects agy quota and parses its relative reset", () => {
  const d = detectEngineExhaustion("agy-claude", AGY, NOW);
  assert.equal(d.exhausted, true);
  // 3h38m2s after NOW
  assert.equal(d.resetAt, new Date(NOW + (3 * 3600 + 38 * 60 + 2) * 1000).toISOString());
  assert.match(d.reason, /quota reached/i);
});

test("detects codex quota and parses its absolute reset (ordinal stripped)", () => {
  const d = detectEngineExhaustion("codex", CODEX, NOW);
  assert.equal(d.exhausted, true);
  assert.ok(d.resetAt, "expected a parsed reset");
  assert.match(d.resetAt ?? "", /^2026-06-26T/); // Jun 26 (time is TZ-dependent; the date is not)
});

test("detects cursor quota and falls back to a cooldown when no reset is given", () => {
  const d = detectEngineExhaustion("cursor", CURSOR, NOW);
  assert.equal(d.exhausted, true);
  assert.equal(d.resetAt, new Date(NOW + 60 * 60 * 1000).toISOString());
});

test("normal engine output is not flagged as exhausted", () => {
  assert.equal(
    detectEngineExhaustion("agy-claude", "Review complete: decision keep_open", NOW).exhausted,
    false,
  );
  assert.equal(detectEngineExhaustion("opencode", AGY, NOW).exhausted, false); // local floor: never flagged
});

test("ledger pre-check: maxed until reset, then clear", () => {
  const dir = mkdtempSync(join(tmpdir(), "eu-"));
  const path = join(dir, "ledger.json");
  try {
    assert.equal(engineUsageStatus("agy-claude", NOW, path).maxed, false); // empty ledger
    assert.equal(recordEngineExhausted("agy-claude", AGY, NOW, path), true);

    const before = engineUsageStatus("agy-claude", NOW + 1000, path);
    assert.equal(before.maxed, true);
    assert.ok(before.until);

    // after the reset has passed, the engine is available again
    const after = engineUsageStatus("agy-claude", NOW + 4 * 3600 * 1000, path);
    assert.equal(after.maxed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
