const VALID_LOGIN_METHODS = new Set(["api", "chatgpt"]);

export function resolveCodexLoginMethod(): string {
  const value = process.env.CLAWSWEEPER_CODEX_LOGIN_METHOD?.trim().toLowerCase();
  if (value && VALID_LOGIN_METHODS.has(value)) {
    return value;
  }
  return "api";
}

export function codexLoginMethodConfig(): string {
  return `forced_login_method="${resolveCodexLoginMethod()}"`;
}

export type CodexEnvOptions = {
  ghToken?: string | undefined;
};

export function codexEnv(options: CodexEnvOptions = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const ghToken = options.ghToken?.trim();
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.COMMIT_SWEEPER_TARGET_GH_TOKEN;
  delete env.CLAWSWEEPER_PROOF_INSPECTION_TOKEN;
  delete env.CLAWSWEEPER_APP_ID;
  delete env.CLAWSWEEPER_APP_PRIVATE_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  if (ghToken) env.GH_TOKEN = ghToken;
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}
