// モデルIDと参考単価の中央設定。コード固定だと価格改定・モデル移行・廃止に弱いため、
// env で上書き可能にし、未設定時は既定値へフォールバックする（レビューv2 §3.2/§7.3）。

export const DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash",
  claude: "claude-sonnet-4-6",
  workers_ai: "@cf/meta/llama-3.1-8b-instruct-fast", // Cloudflare Workers AI（CF上で稼働・ニューロン課金）。
  // WHY -fast：無印 @cf/meta/llama-3.1-8b-instruct は 2026-05-30 に廃止。-fast バリアントは存続（プロンプト互換のドロップイン）。
} as const;

// USD / 100万token（2026-06 公式価格・レビュー§7.1）。
// workers_ai はニューロン課金だが、表示・上限用に概算USD単価を持つ（env MODEL_PRICING で上書き可）。
export const DEFAULT_PRICING: Record<string, { in: number; out: number }> = {
  gemini: { in: 0.30, out: 2.50 },
  claude: { in: 3.0, out: 15.0 },
  workers_ai: { in: 0.05, out: 0.30 },
};

// Cloudflare Workers AI のニューロン課金：$0.011 / 1,000 ニューロン → 1ニューロン = $0.000011。
export const NEURON_USD = 0.011 / 1000;
export function neuronsFromUsd(usd: number): number {
  return usd > 0 ? Math.round(usd / NEURON_USD) : 0;
}

export function geminiModelId(env: Env): string {
  return env.GEMINI_MODEL?.trim() || DEFAULT_MODELS.gemini;
}
export function claudeModelId(env: Env): string {
  return env.CLAUDE_MODEL?.trim() || DEFAULT_MODELS.claude;
}
export function workersAiModelId(env: Env): string {
  return env.WORKERS_AI_MODEL?.trim() || DEFAULT_MODELS.workers_ai;
}

// クラウドAI（Workers AI）で管理者が選べるモデル候補。プロンプト形式（toPrompt）互換の
// テキスト生成instructモデルのみ。廃止サプライズを避けるため、存続が確認済みのものを厳選。
// 上書き優先順位は getWorkersAiModel：KV設定 > env.WORKERS_AI_MODEL > DEFAULT_MODELS.workers_ai。
export const WORKERS_AI_MODELS: { id: string; label: string; note: string }[] = [
  { id: "@cf/meta/llama-3.1-8b-instruct-fast", label: "標準", note: "高速・軽量（既定）" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "高性能", note: "賢いが少し遅い（70B）" },
];
export function isValidWorkersAiModel(id: string): boolean {
  return WORKERS_AI_MODELS.some((m) => m.id === id);
}

// provider に参考単価（token課金）が登録されているか。未登録なら費用推定不可＝UIで
// 「推定不可」を明示し $0（無料）との誤認を避ける（ROADMAP 3-1）。web検索/画像/音声等の
// 回数・秒数課金や BYOK の任意APIは既定で未登録。
export function hasPricing(env: Env, provider: string): boolean {
  return Boolean(resolvePricing(env)[provider]);
}

// env.MODEL_PRICING（JSON: {"gemini":{"in":0.3,"out":2.5},...}）で provider 単位に上書き。
// 妥当な非負数のみ採用し、それ以外は既定値を残す。
export function resolvePricing(env: Env): Record<string, { in: number; out: number }> {
  const merged: Record<string, { in: number; out: number }> = { ...DEFAULT_PRICING };
  const raw = env.MODEL_PRICING;
  if (!raw) return merged;
  try {
    const parsed = JSON.parse(raw) as Record<string, { in?: number; out?: number }>;
    for (const [k, v] of Object.entries(parsed)) {
      const i = Number(v?.in), o = Number(v?.out);
      if (Number.isFinite(i) && i >= 0 && Number.isFinite(o) && o >= 0) merged[k] = { in: i, out: o };
    }
  } catch { /* 不正JSONは既定値のまま */ }
  return merged;
}
