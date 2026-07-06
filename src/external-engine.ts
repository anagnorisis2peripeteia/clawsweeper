// Provider-neutral "bring-your-own-CLI" review engine for the offline local review
// paths (`commit-sweeper local-review` and `clawsweeper review --local-range`).
//
// This ships with ZERO providers: the operator points `--engine external` at any
// read-only CLI via inline flags. Concrete engines (claude / agy / opencode / …)
// are intended as small follow-up PRs, not baked in here — so this file has no
// provider names, models, or quotas, and no network/quota policy.
//
// Every external engine reports a MARKDOWN review. The markdown local-review command
// writes it as the report; `review --local-range` deterministically bridges it into a
// benign advisory Decision (no schema for the engine to satisfy). This module is
// deliberately pure: no fs, git, env, or process spawning. It only (1) parses the inline
// flags into a spec and (2) plans an invocation (command, argv, optional stdin) from a
// prompt. The calling command owns the offline envelope (scrubbed GitHub creds, empty
// GH_CONFIG_DIR, clean committed range), the `git diff`, the temp-file write for `file`
// delivery, and the bounded run — so `external` inherits the same guarantees as codex.

export const EXTERNAL_ENGINE_ID = "external";

// Where the review prompt reaches the CLI:
//   stdin — piped to the process (no OS arg-length limit; default)
//   argv  — substituted at `{prompt}`, or appended as the trailing arg if absent
//   file  — written to a temp file; its path substituted at `{promptFile}`
export type PromptDelivery = "stdin" | "argv" | "file";
export const PROMPT_DELIVERIES: readonly PromptDelivery[] = ["stdin", "argv", "file"];

export interface ExternalEngineSpec {
  command: string; // binary to spawn (e.g. "claude", "opencode", "agy")
  args: string[]; // arg template; {prompt}/{promptFile}/{model} tokens substituted
  promptDelivery: PromptDelivery;
  model: string; // substituted into {model}; "" => the {model} token/arg is dropped
  timeoutMs: number;
}

// An argv-delivered prompt is bounded by the OS command-line limit, so the embedded
// diff is capped tighter than for stdin/file (which are bounded only by prompt size).
// Mirrors the caps the built-in read-only engines already use.
export const EXTERNAL_ARGV_MAX_DIFF_BYTES = process.platform === "win32" ? 24 * 1024 : 96 * 1024;
export const EXTERNAL_STREAM_MAX_DIFF_BYTES = 256 * 1024;

export function externalDiffCap(delivery: PromptDelivery): number {
  return delivery === "argv" ? EXTERNAL_ARGV_MAX_DIFF_BYTES : EXTERNAL_STREAM_MAX_DIFF_BYTES;
}

const DEFAULT_EXTERNAL_TIMEOUT_MS = 1_800_000; // 30 min, matching the codex/local-review default

export const PROMPT_TOKEN = "{prompt}";
export const PROMPT_FILE_TOKEN = "{promptFile}";
export const MODEL_TOKEN = "{model}";

function isPromptDelivery(value: string): value is PromptDelivery {
  return (PROMPT_DELIVERIES as readonly string[]).includes(value);
}

function someArgIncludes(args: readonly string[], token: string): boolean {
  return args.some((arg) => arg.includes(token));
}

// Parse the inline `--external-*` flags into a validated spec. Kept free of the
// harness Args type: the caller extracts the raw flag strings and hands them in,
// so this stays unit-testable in isolation. Throws on any malformed input with a
// message aimed at the operator wiring up a new CLI slot.
export function externalEngineSpecFromFlags(raw: {
  command: string;
  argsJson: string; // JSON array of strings, e.g. '["-p","--output-format","text"]'
  promptDelivery: string;
  model: string;
  timeoutMs: number;
}): ExternalEngineSpec {
  const command = raw.command.trim();
  if (!command) {
    throw new Error(
      "--engine external requires --external-cmd <binary> (the read-only review CLI to run).",
    );
  }

  let args: string[];
  const argsText = raw.argsJson.trim() || "[]";
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === "string")) {
      throw new Error("not a JSON array of strings");
    }
    args = parsed;
  } catch (error) {
    throw new Error(
      `--external-args must be a JSON array of strings (e.g. '["-p","--output-format","text"]'), got ${JSON.stringify(
        argsText,
      )}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const promptDelivery = (raw.promptDelivery.trim() || "stdin").toLowerCase();
  if (!isPromptDelivery(promptDelivery)) {
    throw new Error(
      `--external-prompt must be one of ${PROMPT_DELIVERIES.join(", ")}, got "${raw.promptDelivery}".`,
    );
  }

  // Fail loud on tokens that can't be honored for the chosen delivery, rather than
  // silently shipping the literal "{prompt}" string to the CLI.
  if (promptDelivery !== "argv" && someArgIncludes(args, PROMPT_TOKEN)) {
    throw new Error(
      `${PROMPT_TOKEN} in --external-args is only meaningful with --external-prompt argv (got ${promptDelivery}).`,
    );
  }
  if (promptDelivery !== "file" && someArgIncludes(args, PROMPT_FILE_TOKEN)) {
    throw new Error(
      `${PROMPT_FILE_TOKEN} in --external-args is only meaningful with --external-prompt file (got ${promptDelivery}).`,
    );
  }
  if (promptDelivery === "file" && !someArgIncludes(args, PROMPT_FILE_TOKEN)) {
    throw new Error(
      `--external-prompt file requires ${PROMPT_FILE_TOKEN} somewhere in --external-args so the CLI receives the prompt path.`,
    );
  }

  const model = raw.model.trim();
  if (!model && someArgIncludes(args, MODEL_TOKEN)) {
    throw new Error(
      `--external-args uses ${MODEL_TOKEN} but no --external-model was given. Pass --external-model, or drop ${MODEL_TOKEN}.`,
    );
  }

  const timeoutMs =
    Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
      ? raw.timeoutMs
      : DEFAULT_EXTERNAL_TIMEOUT_MS;

  return { command, args, promptDelivery, model, timeoutMs };
}

// A planned invocation for the bounded runner. `input` is the stdin payload: the
// prompt for stdin delivery, and an empty string (harmless empty stdin) for argv/file
// delivery. `args` is the fully-substituted argv.
export interface ExternalRunPlan {
  command: string;
  args: string[];
  input: string;
}

interface SubstitutionValues {
  prompt: string;
  promptFile: string;
  model: string;
}

// Substitute the templated tokens in one arg. A standalone bare {model} whose value is
// empty drops that arg (defensive — externalEngineSpecFromFlags already rejects {model}
// without --external-model). Author templates with the token as its own arg (`--model {model}`).
function substituteArg(arg: string, values: SubstitutionValues): string | null {
  if (arg === MODEL_TOKEN && !values.model) return null;
  return arg
    .split(PROMPT_TOKEN)
    .join(values.prompt)
    .split(PROMPT_FILE_TOKEN)
    .join(values.promptFile)
    .split(MODEL_TOKEN)
    .join(values.model);
}

// Values substituted into the arg template at run time. Optional: the stdin/argv paths
// pass nothing; `file` delivery passes the promptFile the caller has already written.
export interface ExternalRunSubstitutions {
  promptFile?: string;
}

// Plan the invocation from the spec + the built review prompt. Pure: for `file` delivery
// the caller must have already written subs.promptFile and pass it here.
export function planExternalRun(
  spec: ExternalEngineSpec,
  prompt: string,
  subs: ExternalRunSubstitutions = {},
): ExternalRunPlan {
  const values: SubstitutionValues = {
    prompt: spec.promptDelivery === "argv" ? prompt : "",
    promptFile: subs.promptFile ?? "",
    model: spec.model,
  };
  const substituted = spec.args
    .map((arg) => substituteArg(arg, values))
    .filter((arg): arg is string => arg !== null);

  // argv delivery with no explicit {prompt} token => append the prompt as the
  // trailing arg (matches the common `<cli> run "<prompt>"` shape).
  if (spec.promptDelivery === "argv" && !someArgIncludes(spec.args, PROMPT_TOKEN)) {
    substituted.push(prompt);
  }

  return {
    command: spec.command,
    args: substituted,
    input: spec.promptDelivery === "stdin" ? prompt : "",
  };
}
