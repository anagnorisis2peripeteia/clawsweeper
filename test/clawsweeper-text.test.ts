import assert from "node:assert/strict";
import test from "node:test";

import { trimMiddle } from "../dist/clawsweeper-text.js";

test("trimMiddle handles a maxLength below the head/tail overhead without garbage", () => {
  const text = "x".repeat(25);
  // Regression: maxLength < 120 made `edge` negative — the slices read the wrong ends
  // (slice(-0) returns the whole string) and the "truncated N" count exceeded text.length.
  const out = trimMiddle(text, 20);
  assert.equal(out, `${"x".repeat(20)}\n\n[truncated 5 chars]`);
  const m = out.match(/truncated (-?\d+) chars/);
  if (m) {
    const removed = Number(m[1]);
    assert.ok(
      removed >= 0 && removed <= text.length,
      `nonsensical truncated count ${removed} for input ${text.length}`,
    );
  }
  assert.ok(!out.includes(text), "must not echo the whole input via slice(-0)");

  // At exactly 120 the computed edge is zero, so this boundary must use the same fallback.
  assert.equal(trimMiddle("x".repeat(125), 120), `${"x".repeat(120)}\n\n[truncated 5 chars]`);
});

test("trimMiddle still middle-truncates for a normal large cap", () => {
  const out = trimMiddle("y".repeat(5000), 4000);
  assert.ok(out.includes("... truncated"), "large-cap path should keep the middle-elision marker");
  assert.ok(out.startsWith("y") && out.endsWith("y"), "should keep a real head and tail");
});
