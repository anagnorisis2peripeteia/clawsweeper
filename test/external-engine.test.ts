import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTERNAL_ENGINE_ID,
  externalDiffCap,
  externalEngineSpecFromFlags,
  planExternalRun,
  type ExternalEngineSpec,
} from "../src/external-engine.ts";

const baseFlags = {
  command: "mycli",
  argsJson: "[]",
  promptDelivery: "stdin",
  model: "",
  timeoutMs: 1_800_000,
};

function specOf(overrides: Partial<ExternalEngineSpec> = {}): ExternalEngineSpec {
  return {
    command: "c",
    args: [],
    promptDelivery: "stdin",
    model: "",
    timeoutMs: 1000,
    ...overrides,
  };
}

// --- externalEngineSpecFromFlags -------------------------------------------------

test("externalEngineSpecFromFlags parses a valid stdin spec", () => {
  const spec = externalEngineSpecFromFlags({ ...baseFlags, argsJson: '["-p"]' });
  assert.equal(spec.command, "mycli");
  assert.deepEqual(spec.args, ["-p"]);
  assert.equal(spec.promptDelivery, "stdin");
  assert.equal(spec.model, "");
});

test("externalEngineSpecFromFlags accepts argv delivery", () => {
  const spec = externalEngineSpecFromFlags({ ...baseFlags, promptDelivery: "argv" });
  assert.equal(spec.promptDelivery, "argv");
});

test("externalEngineSpecFromFlags throws on an empty command", () => {
  assert.throws(() => externalEngineSpecFromFlags({ ...baseFlags, command: "   " }));
});

test("externalEngineSpecFromFlags throws when args is not a JSON string array", () => {
  assert.throws(() => externalEngineSpecFromFlags({ ...baseFlags, argsJson: "{}" }));
  assert.throws(() => externalEngineSpecFromFlags({ ...baseFlags, argsJson: '["a",1]' }));
});

test("externalEngineSpecFromFlags defaults empty argsJson to []", () => {
  const spec = externalEngineSpecFromFlags({ ...baseFlags, argsJson: "" });
  assert.deepEqual(spec.args, []);
});

test("externalEngineSpecFromFlags throws on an unknown prompt delivery", () => {
  assert.throws(() => externalEngineSpecFromFlags({ ...baseFlags, promptDelivery: "pipe" }));
});

test("externalEngineSpecFromFlags rejects {prompt} unless delivery is argv", () => {
  assert.throws(() =>
    externalEngineSpecFromFlags({
      ...baseFlags,
      promptDelivery: "stdin",
      argsJson: '["{prompt}"]',
    }),
  );
});

test("externalEngineSpecFromFlags rejects {promptFile} unless delivery is file", () => {
  assert.throws(() =>
    externalEngineSpecFromFlags({
      ...baseFlags,
      promptDelivery: "argv",
      argsJson: '["{promptFile}"]',
    }),
  );
});

test("externalEngineSpecFromFlags requires {promptFile} for file delivery", () => {
  assert.throws(() =>
    externalEngineSpecFromFlags({ ...baseFlags, promptDelivery: "file", argsJson: '["-p"]' }),
  );
  const spec = externalEngineSpecFromFlags({
    ...baseFlags,
    promptDelivery: "file",
    argsJson: '["--in","{promptFile}"]',
  });
  assert.equal(spec.promptDelivery, "file");
});

test("externalEngineSpecFromFlags rejects {model} without a model", () => {
  assert.throws(() =>
    externalEngineSpecFromFlags({ ...baseFlags, argsJson: '["--model","{model}"]', model: "" }),
  );
  const spec = externalEngineSpecFromFlags({
    ...baseFlags,
    argsJson: '["--model","{model}"]',
    model: "gpt",
  });
  assert.equal(spec.model, "gpt");
});

test("externalEngineSpecFromFlags falls back to a positive default timeout", () => {
  assert.ok(externalEngineSpecFromFlags({ ...baseFlags, timeoutMs: 0 }).timeoutMs > 0);
  assert.ok(externalEngineSpecFromFlags({ ...baseFlags, timeoutMs: Number.NaN }).timeoutMs > 0);
});

// --- planExternalRun -------------------------------------------------------------

test("planExternalRun (stdin) sends the prompt on stdin, not argv", () => {
  const plan = planExternalRun(specOf({ args: ["-p"] }), "REVIEW");
  assert.equal(plan.input, "REVIEW");
  assert.deepEqual(plan.args, ["-p"]);
});

test("planExternalRun (argv) substitutes an explicit {prompt} token", () => {
  const plan = planExternalRun(
    specOf({ promptDelivery: "argv", args: ["run", "{prompt}"] }),
    "REVIEW",
  );
  assert.deepEqual(plan.args, ["run", "REVIEW"]);
  assert.equal(plan.input, "");
});

test("planExternalRun (argv) appends the prompt when there is no {prompt} token", () => {
  const plan = planExternalRun(specOf({ promptDelivery: "argv", args: ["run"] }), "REVIEW");
  assert.deepEqual(plan.args, ["run", "REVIEW"]);
});

test("planExternalRun (file) substitutes {promptFile} and empties stdin", () => {
  const plan = planExternalRun(
    specOf({ promptDelivery: "file", args: ["--in", "{promptFile}"] }),
    "REVIEW",
    { promptFile: "/tmp/p.md" },
  );
  assert.deepEqual(plan.args, ["--in", "/tmp/p.md"]);
  assert.equal(plan.input, "");
});

test("planExternalRun substitutes {model} when set", () => {
  const plan = planExternalRun(specOf({ args: ["--model", "{model}"], model: "gpt" }), "R");
  assert.deepEqual(plan.args, ["--model", "gpt"]);
});

test("planExternalRun drops a standalone empty {model} token", () => {
  const plan = planExternalRun(specOf({ args: ["{model}", "-p"], model: "" }), "R");
  assert.deepEqual(plan.args, ["-p"]);
});

// --- misc ------------------------------------------------------------------------

test("externalDiffCap is tighter for argv than for stdin", () => {
  assert.ok(externalDiffCap("argv") < externalDiffCap("stdin"));
});

test("EXTERNAL_ENGINE_ID is 'external'", () => {
  assert.equal(EXTERNAL_ENGINE_ID, "external");
});
