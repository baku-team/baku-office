// UIテーマ（第1層：実行時・団体ごと・コード不要）。
// CSS は既に :root 変数化済み。ここで団体ごとの上書き値を持ち、App.astro が head に注入する。
import type { Ctx } from "./ports.ts";

export type ThemeColors = Partial<Record<"bg" | "surface" | "ink" | "muted" | "line" | "brand" | "brandInk" | "ok" | "warn" | "danger", string>>;
// mascotUrl=相棒（エージェント）キャラ画像。未設定なら既定の貘キャラ（/mascot/baku.png）。
export type ThemeConfig = { brand?: string; logoUrl?: string; mascotUrl?: string; colors?: ThemeColors };

const DEFAULT_BRAND = "baku-office";
const VAR: Record<keyof ThemeColors, string> = {
  bg: "--bg", surface: "--surface", ink: "--ink", muted: "--muted", line: "--line",
  brand: "--brand", brandInk: "--brand-ink", ok: "--ok", warn: "--warn", danger: "--danger",
};
// CSS インジェクション防止：色値は hex / rgb(a) / hsl(a) / 単純な名前のみ許可。
const SAFE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s]+\)$|^[a-zA-Z]{3,20}$/;

export function brandName(t: ThemeConfig | null): string {
  return (t?.brand ?? "").trim() || DEFAULT_BRAND;
}

// :root 上書きCSSを生成（与えられた色だけ・不正値は捨てる）。色が無ければ空文字。
export function themeCss(t: ThemeConfig | null): string {
  const c = t?.colors ?? {};
  const decls: string[] = [];
  for (const k of Object.keys(VAR) as (keyof ThemeColors)[]) {
    const v = c[k];
    if (typeof v === "string" && SAFE.test(v.trim())) decls.push(`${VAR[k]}: ${v.trim()};`);
  }
  return decls.length ? `:root{${decls.join("")}}` : "";
}

// 保存前のサニタイズ（不正色を除去・brand/logoは長さ制限）。
export function sanitizeTheme(input: unknown): ThemeConfig {
  const o = (input ?? {}) as ThemeConfig;
  const out: ThemeConfig = {};
  if (typeof o.brand === "string" && o.brand.trim()) out.brand = o.brand.trim().slice(0, 40);
  // ロゴ：外部URL（http/https）か同一オリジンの相対パス（アップロード時の /api/logo?... 等）のみ許可。
  if (typeof o.logoUrl === "string") { const u = o.logoUrl.trim(); if (/^https?:\/\//.test(u) || /^\/[\w./?=&-]+$/.test(u)) out.logoUrl = u.slice(0, 400); }
  // 相棒画像：外部URL（https）か同一オリジンの相対パス（/mascot/... 等）のみ許可。
  if (typeof o.mascotUrl === "string") { const u = o.mascotUrl.trim(); if (/^https:\/\//.test(u) || /^\/[\w./?=&-]+$/.test(u)) out.mascotUrl = u.slice(0, 400); }
  const colors: ThemeColors = {};
  const ic = (o.colors ?? {}) as ThemeColors;
  for (const k of Object.keys(VAR) as (keyof ThemeColors)[]) {
    const v = ic[k];
    if (typeof v === "string" && SAFE.test(v.trim())) colors[k] = v.trim();
  }
  if (Object.keys(colors).length) out.colors = colors;
  return out;
}

const KV_THEME = "ui_theme";
export async function getTheme(ctx: Ctx): Promise<ThemeConfig> {
  const raw = await ctx.storage.kv.get(KV_THEME);
  if (!raw) return {};
  try { return sanitizeTheme(JSON.parse(raw)); } catch { return {}; }
}
export async function setTheme(ctx: Ctx, input: unknown): Promise<ThemeConfig> {
  const t = sanitizeTheme(input);
  await ctx.storage.kv.put(KV_THEME, JSON.stringify(t));
  return t;
}
