// API使用量（回数ベース）の記録・集計・上限。AI機能や各APIの利用を日次でカウントし、
// 「API使用量」画面で可視化＋無料枠アラート＋従量上限を制御する（§使用量画面）。
export const USAGE_PROVIDERS = ["gemini", "claude", "web_search", "image_gen", "tts", "video_gen", "custom"] as const;
export type UsageProvider = string;

export const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini（AI）", claude: "Claude（AI）", web_search: "Web検索", image_gen: "画像生成", tts: "音声合成", video_gen: "動画生成", custom: "カスタムAPI",
};

const todayUtc = (): string => new Date().toISOString().slice(0, 10);
const monthUtc = (): string => new Date().toISOString().slice(0, 7);

// 1回分を加算（テーブル未作成等は黙って無視＝記録失敗で本処理を止めない）。
export async function recordUsage(env: Env, provider: string): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO api_usage (provider, day, count) VALUES (?,?,1) ON CONFLICT(provider, day) DO UPDATE SET count = count + 1",
    ).bind(provider, todayUtc()).run();
  } catch { /* noop */ }
}

export type DayCount = { day: string; count: number };

// 直近 days 日の日次合計（全プロバイダ合算）。グラフ用に欠損日は0で補完。
export async function dailyTotals(env: Env, days = 14): Promise<DayCount[]> {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  let rows: { day: string; c: number }[] = [];
  try {
    rows = (await env.DB.prepare("SELECT day, SUM(count) AS c FROM api_usage WHERE day >= ? GROUP BY day").bind(since).all<{ day: string; c: number }>()).results;
  } catch { /* テーブル未作成 */ }
  const map = new Map(rows.map((r) => [r.day, r.c]));
  const out: DayCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push({ day: d, count: map.get(d) ?? 0 });
  }
  return out;
}

// 当月のプロバイダ別合計／当日のプロバイダ別合計。
export async function monthTotals(env: Env): Promise<Record<string, number>> {
  try {
    const rows = (await env.DB.prepare("SELECT provider, SUM(count) AS c FROM api_usage WHERE day LIKE ? GROUP BY provider").bind(monthUtc() + "%").all<{ provider: string; c: number }>()).results;
    return Object.fromEntries(rows.map((r) => [r.provider, r.c]));
  } catch { return {}; }
}
export async function todayTotals(env: Env): Promise<Record<string, number>> {
  try {
    const rows = (await env.DB.prepare("SELECT provider, count FROM api_usage WHERE day = ?").bind(todayUtc()).all<{ provider: string; count: number }>()).results;
    return Object.fromEntries(rows.map((r) => [r.provider, r.count]));
  } catch { return {}; }
}

// 上限設定（KV）。freeQuota=無料枠（日次・アラート用）／monthlyCap=従量上限（当月）／onExceed=超過時の挙動。
export type Limit = { freeQuota?: number; monthlyCap?: number; onExceed?: "switch_free" | "pause" };
export type Limits = Record<string, Limit>;
export async function getLimits(env: Env): Promise<Limits> {
  try { return JSON.parse((await env.LICENSE.get("usage_limits")) ?? "{}") as Limits; } catch { return {}; }
}
export async function setLimits(env: Env, l: Limits): Promise<void> {
  await env.LICENSE.put("usage_limits", JSON.stringify(l ?? {}));
}

// 従量上限の判定：当月合計が monthlyCap 以上なら onExceed（既定 pause）を返す。
export async function overBudget(env: Env, provider: string): Promise<"ok" | "switch_free" | "pause"> {
  const lim = (await getLimits(env))[provider];
  if (!lim?.monthlyCap || lim.monthlyCap <= 0) return "ok";
  const used = (await monthTotals(env))[provider] ?? 0;
  if (used >= lim.monthlyCap) return lim.onExceed ?? "pause";
  return "ok";
}

// 無料枠/上限のリセット時刻（表示用・UTC）。日次=翌0時、月次=翌月1日。
export function resetTimes(): { daily: string; monthly: string } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const mo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const fmt = (x: Date) => x.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return { daily: fmt(d), monthly: fmt(mo) };
}
