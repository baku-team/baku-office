// モデルIDと参考単価の中央設定。コード固定だと価格改定・モデル移行・廃止に弱いため、
// env で上書き可能にし、未設定時は既定値へフォールバックする（レビューv2 §3.2/§7.3）。

export const DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash",
  claude: "claude-sonnet-4-6",
} as const;

// USD / 100万token（2026-06 公式価格・レビュー§7.1）。
export const DEFAULT_PRICING: Record<string, { in: number; out: number }> = {
  gemini: { in: 0.30, out: 2.50 },
  claude: { in: 3.0, out: 15.0 },
};

export function geminiModelId(env: Env): string {
  return env.GEMINI_MODEL?.trim() || DEFAULT_MODELS.gemini;
}
export function claudeModelId(env: Env): string {
  return env.CLAUDE_MODEL?.trim() || DEFAULT_MODELS.claude;
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
