// Usage-aware engine selection. None of agy / codex / cursor expose a scriptable
// "how much usage is left?" query — the only signal is the quota error on a run.
// So availability is tracked in a local LEDGER: when an engine returns a limit
// error we record it plus when it resets (parsed from the error — agy gives a
// relative "Resets in 3h38m2s", codex an absolute "try again at <date>"), and a
// pre-check skips any engine that is known-maxed-until-future without burning a call.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// CLAWSWEEPER_ENGINE_USAGE_FILE overrides the ledger location — primarily so tests
// that spawn the real CLI stay hermetic (the developer's live ledger recording a
// genuinely-maxed engine must not make stubbed-engine tests skip that engine).
export const ENGINE_USAGE_LEDGER_PATH =
  process.env.CLAWSWEEPER_ENGINE_USAGE_FILE?.trim() ||
  join(homedir(), ".clawsweeper-engine-usage.json");

export interface EngineUsageEntry {
  exhaustedAt: string;
  resetAt: string | null;
  reason: string;
}
export type EngineUsageLedger = Record<string, EngineUsageEntry>;

export function loadEngineUsageLedger(path = ENGINE_USAGE_LEDGER_PATH): EngineUsageLedger {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as EngineUsageLedger) : {};
  } catch {
    return {};
  }
}

function saveEngineUsageLedger(ledger: EngineUsageLedger, path = ENGINE_USAGE_LEDGER_PATH): void {
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

// Cooldown (ms) for engines whose limit error carries no reset time (cursor).
const DEFAULT_COOLDOWN_MS: Record<string, number> = { cursor: 60 * 60 * 1000 };
const FALLBACK_COOLDOWN_MS = 60 * 60 * 1000;

const QUOTA_RULES: Array<{ match: (engine: string) => boolean; re: RegExp }> = [
  {
    match: (e) => e.startsWith("agy"),
    re: /RESOURCE_EXHAUSTED|code 429|quota reached|individual quota/i,
  },
  { match: (e) => e === "codex", re: /hit your usage limit|usage limit|rate.?limit/i },
  { match: (e) => e === "cursor", re: /actionrequirederror|hit your usage limit|usage limit/i },
];

function parseResetAt(engine: string, text: string, nowMs: number): string | null {
  const rel = text.match(/resets?\s+in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms = (Number(rel[1] ?? 0) * 3600 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0)) * 1000;
    if (ms > 0) return new Date(nowMs + ms).toISOString();
  }
  const abs = text.match(/try again at\s+([^.\n]+)/i);
  if (abs?.[1]) {
    // strip ordinal suffixes ("26th" -> "26") so Date.parse can read it
    const cleaned = abs[1].trim().replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
    const parsed = Date.parse(cleaned);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(nowMs + (DEFAULT_COOLDOWN_MS[engine] ?? FALLBACK_COOLDOWN_MS)).toISOString();
}

// Did this engine's output indicate it is out of usage? If so, when does it reset?
export function detectEngineExhaustion(
  engine: string,
  output: string,
  nowMs: number,
): { exhausted: boolean; resetAt: string | null; reason: string } {
  const text = output || "";
  const rule = QUOTA_RULES.find((r) => r.match(engine));
  if (!rule || !rule.re.test(text)) return { exhausted: false, resetAt: null, reason: "" };
  const reason = (
    text.match(/[^\n]*(quota reached|usage limit|resource_exhausted)[^\n]*/i)?.[0] ??
    "quota exhausted"
  )
    .trim()
    .slice(0, 200);
  return { exhausted: true, resetAt: parseResetAt(engine, text, nowMs), reason };
}

export function recordEngineExhausted(
  engine: string,
  output: string,
  nowMs: number,
  path = ENGINE_USAGE_LEDGER_PATH,
): boolean {
  const detected = detectEngineExhaustion(engine, output, nowMs);
  if (!detected.exhausted) return false;
  const ledger = loadEngineUsageLedger(path);
  ledger[engine] = {
    exhaustedAt: new Date(nowMs).toISOString(),
    resetAt: detected.resetAt,
    reason: detected.reason,
  };
  saveEngineUsageLedger(ledger, path);
  return true;
}

// Pre-check: is the engine known-maxed right now (ledger reset still in the future)?
export function engineUsageStatus(
  engine: string,
  nowMs: number,
  path = ENGINE_USAGE_LEDGER_PATH,
): { maxed: boolean; until: string | null; reason: string | null } {
  const entry = loadEngineUsageLedger(path)[engine];
  if (!entry?.resetAt) return { maxed: false, until: null, reason: null };
  const resetMs = Date.parse(entry.resetAt);
  if (Number.isFinite(resetMs) && resetMs > nowMs) {
    return { maxed: true, until: entry.resetAt, reason: entry.reason };
  }
  return { maxed: false, until: null, reason: null };
}
