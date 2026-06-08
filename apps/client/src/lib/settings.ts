// クライアント設定（高度なオプション）。LICENSE KV に保存。組織単位の軽量設定。
export type AiEngine = "gemini" | "claude";

// AIエンジン選択（既定 gemini=無料／claude=BYOK）。Plus以上で Claude を任意選択可。
export async function getAiEngine(env: Env): Promise<AiEngine> {
  return (await env.LICENSE.get("ai_engine")) === "claude" ? "claude" : "gemini";
}
export async function setAiEngine(env: Env, e: string): Promise<AiEngine> {
  const v: AiEngine = e === "claude" ? "claude" : "gemini";
  await env.LICENSE.put("ai_engine", v);
  return v;
}

// AIへ追加するカスタム指示（口調・人格・回答形式など）。system に追記される。
const CUSTOM_PROMPT_MAX = 2000;
export async function getCustomPrompt(env: Env): Promise<string> {
  return (await env.LICENSE.get("custom_prompt")) ?? "";
}
export async function setCustomPrompt(env: Env, s: string): Promise<string> {
  const v = (s ?? "").slice(0, CUSTOM_PROMPT_MAX);
  await env.LICENSE.put("custom_prompt", v);
  return v;
}

// Workers Paid（CF有料プラン）有効フラグ。管理者が「CFをPaidにした」と申告して上限を引き上げる。
// CF側から自動検出はできないため自己申告。マルチエージェントの並列数・ジョブ規模・ホップ上限の引き上げに使う。
export async function getWorkersPaid(env: Env): Promise<boolean> {
  return (await env.LICENSE.get("workers_paid")) === "true";
}
export async function setWorkersPaid(env: Env, enabled: boolean): Promise<boolean> {
  await env.LICENSE.put("workers_paid", enabled ? "true" : "false");
  return enabled;
}

// マルチエージェントの同時実行上限（無料枠は subrequest/CPU 制約のため控えめ、Paid で拡張）。
export async function maxParallelAgents(env: Env): Promise<number> {
  return (await getWorkersPaid(env)) ? 5 : 2;
}
// スーパーバイザーのホップ上限（Paid でより多段の委譲を許可）。
export async function agentMaxHops(env: Env): Promise<number> {
  return (await getWorkersPaid(env)) ? 6 : 4;
}
