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
