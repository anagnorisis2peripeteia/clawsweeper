import assert from "node:assert/strict";
import test from "node:test";

import { compactText, slug } from "../../dist/repair/text-utils.js";

test("compactText never exceeds maxLength, even for tiny caps", () => {
  for (const n of [0, 1, 2, 3, 5, 16]) {
    assert.ok(
      compactText("hello world this is long", n).length <= n,
      `compactText(..., ${n}) must fit within ${n}`,
    );
  }
  // Regression: maxLength 2 used to return the bare "..." (length 3).
  assert.equal(compactText("hello world", 2), "he");
});

test("slug is idempotent (a trailing dash is not re-introduced by the length slice)", () => {
  for (const [value, max] of [
    ["a a", 2],
    ["aa----bb", 3],
    ["My Repo Name!!", 6],
    ["...", 2],
  ] as const) {
    const once = slug(value, "x", max);
    assert.equal(
      slug(once, "x", max),
      once,
      `slug not idempotent for ${JSON.stringify(value)}@${max}`,
    );
    assert.ok(
      !once.endsWith("-") || once === "x",
      `slug left a trailing dash: ${JSON.stringify(once)}`,
    );
  }
  // Unregressed: normal slugs are unchanged.
  assert.equal(slug("my-repo-name"), "my-repo-name");
});
