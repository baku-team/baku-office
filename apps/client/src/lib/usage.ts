import { kvPut } from "./kv.ts";
// API使用量（回数ベース）の記録・集計・上限。AI機能や各APIの利用を日次でカウントし、
// 「API使用量」画面で可視化＋無料枠アラート＋従量上限を制御する（§使用量画面）。
import { resolvePricing, NEURON_USD } from "../core/models/config.ts";
import { logDiag } from "./diag.ts";

// 使用量の記録失敗を診断に残す（P1-2）。WHY: 握りつぶすと上限判定が壊れても気づけない。
// auto-report の連鎖を避けるため warn（error にしない）。記録失敗で本処理は止めない。
function noteRecordFailure(env: Env, provider: string, e: unknown): void {
  void logDiag(env, "warn", "usage", `使用量記録に失敗（上限判定が不正確になる恐れ）: ${provider}`, (e as Error)?.message ?? String(e));
}

export const USAGE_PROVIDERS = ["gemini", "claude", "workers_ai", "web_search", "image_gen", "tts", "video_gen", "custom"] as const;
export type UsageProvider = string;

export const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini（AI）", claude: "Claude（AI）", workers_ai: "Workers AI（CF・ニューロン）", web_search: "Web検索", image_gen: "画像生成", tts: "音声合成", video_gen: "動画生成", custom: "カスタムAPI",
};

// 当月の推定ニューロン（workers_ai 用）。est_usd ÷ ニューロン単価。
export async function monthNeurons(env: Env): Promise<number> {
  const usd = (await monthUsd(env))["workers_ai"] ?? 0;
  return usd > 0 ? Math.round(usd / NEURON_USD) : 0;
}

const todayUtc = (): string => new Date().toISOString().slice(0, 10);
const monthUtc = (): string => new Date().toISOString().slice(0, 7);

export type TokenUsage = { inputTokens: number; outputTokens: number };
// 入出力token から推定USDを算出（単価未登録のproviderは0）。単価は env で上書き可能（config.ts）。
export function estimateUsd(env: Env, provider: string, inputTokens: number, outputTokens: number): number {
  const p = resolvePricing(env)[provider];
  if (!p) return 0;
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

// 1回分を加算（テーブル未作成等は黙って無視＝記録失敗で本処理を止めない）。
export async function recordUsage(env: Env, provider: string): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO api_usage (provider, day, count) VALUES (?,?,1) ON CONFLICT(provider, day) DO UPDATE SET count = count + 1",
    ).bind(provider, todayUtc()).run();
  } catch (e) { noteRecordFailure(env, provider, e); }
}

// 応答 usage（input/output token）と推定USDを加算。countは増やさない（recordUsageと二重計上を避ける）。
export async function recordTokens(env: Env, provider: string, u: TokenUsage): Promise<void> {
  const i = Math.max(0, Math.round(u?.inputTokens ?? 0));
  const o = Math.max(0, Math.round(u?.outputTokens ?? 0));
  if (i === 0 && o === 0) return;
  const usd = estimateUsd(env, provider, i, o);
  try {
    await env.DB.prepare(
      "INSERT INTO api_usage (provider, day, count, input_tokens, output_tokens, est_usd) VALUES (?,?,0,?,?,?) ON CONFLICT(provider, day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, est_usd = est_usd + excluded.est_usd",
    ).bind(provider, todayUtc(), i, o, usd).run();
  } catch (e) { noteRecordFailure(env, provider, e); }
}

// token以外の従量単位（Web検索回数・音声/動画秒数など）を加算。
export async function recordUnits(env: Env, provider: string, units: number): Promise<void> {
  const n = Math.max(0, Math.round(units ?? 0));
  if (n === 0) return;
  try {
    await env.DB.prepare(
      "INSERT INTO api_usage (provider, day, count, units) VALUES (?,?,0,?) ON CONFLICT(provider, day) DO UPDATE SET units = units + excluded.units",
    ).bind(provider, todayUtc(), n).run();
  } catch (e) { noteRecordFailure(env, provider, e); }
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

// 当月のプロバイダ別の推定USD合計（hard cap 判定・表示用）。
export async function monthUsd(env: Env): Promise<Record<string, number>> {
  try {
    const rows = (await env.DB.prepare("SELECT provider, SUM(est_usd) AS u FROM api_usage WHERE day LIKE ? GROUP BY provider").bind(monthUtc() + "%").all<{ provider: string; u: number }>()).results;
    return Object.fromEntries(rows.map((r) => [r.provider, r.u ?? 0]));
  } catch { return {}; }
}
// 当月のプロバイダ別の token 合計（input+output・表示用）。
export async function monthTokens(env: Env): Promise<Record<string, number>> {
  try {
    const rows = (await env.DB.prepare("SELECT provider, SUM(input_tokens + output_tokens) AS t FROM api_usage WHERE day LIKE ? GROUP BY provider").bind(monthUtc() + "%").all<{ provider: string; t: number }>()).results;
    return Object.fromEntries(rows.map((r) => [r.provider, r.t ?? 0]));
  } catch { return {}; }
}

// 上限設定（KV）。freeQuota=無料枠（日次・アラート用）／monthlyCap=回数上限（当月）／
// monthlyUsdCap=推定費用の hard cap（当月・USD）／onExceed=超過時の挙動。
export type Limit = { freeQuota?: number; monthlyCap?: number; monthlyUsdCap?: number; monthlyNeuronCap?: number; onExceed?: "switch_free" | "pause" };
export type Limits = Record<string, Limit>;
export async function getLimits(env: Env): Promise<Limits> {
  try { return JSON.parse((await env.LICENSE.get("usage_limits")) ?? "{}") as Limits; } catch { return {}; }
}
export async function setLimits(env: Env, l: Limits): Promise<void> {
  await kvPut(env, "usage_limits", JSON.stringify(l ?? {}));
}

// 従量上限の判定：当月の推定費用が monthlyUsdCap 以上、または回数が monthlyCap 以上なら
// onExceed（既定 pause）を返す。USD cap が実費ベースの hard cap（レビュー P0-2）。
export async function overBudget(env: Env, provider: string): Promise<"ok" | "switch_free" | "pause"> {
  const lim = (await getLimits(env))[provider];
  if (!lim) return "ok";
  if (lim.monthlyUsdCap && lim.monthlyUsdCap > 0) {
    const usd = (await monthUsd(env))[provider] ?? 0;
    if (usd >= lim.monthlyUsdCap) return lim.onExceed ?? "pause";
  }
  // ニューロン上限（workers_ai 用）：est_usd 換算で判定。
  if (lim.monthlyNeuronCap && lim.monthlyNeuronCap > 0) {
    const usd = (await monthUsd(env))[provider] ?? 0;
    if (usd >= lim.monthlyNeuronCap * NEURON_USD) return lim.onExceed ?? "pause";
  }
  if (lim.monthlyCap && lim.monthlyCap > 0) {
    const used = (await monthTotals(env))[provider] ?? 0;
    if (used >= lim.monthlyCap) return lim.onExceed ?? "pause";
  }
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
