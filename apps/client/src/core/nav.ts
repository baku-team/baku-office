// ナビ構成（第2層：実行時・団体ごと）。共通ベース＋有効パーツの menu を合成し、
// 団体ごとの上書き（非表示・ラベル変更・並び替え）を適用する。
import type { Ctx } from "./ports.ts";

export type NavItem = { href: string; label: string; show?: boolean };
export type NavOverrides = { hidden?: string[]; labels?: Record<string, string>; order?: string[] };

// base（共通ナビ）＋ partItems（有効パーツ提供）を合成し、override を適用。
export function buildNav(base: NavItem[], partItems: NavItem[], ov: NavOverrides | null): NavItem[] {
  const hidden = new Set(ov?.hidden ?? []);
  const labels = ov?.labels ?? {};
  // show!==false のみ採用、非表示を除外、ラベル上書き。
  let items = [...base, ...partItems]
    .filter((i) => i.show !== false && !hidden.has(i.href))
    .map((i) => ({ href: i.href, label: labels[i.href] ?? i.label }));
  // href で重複排除（先勝ち＝base優先）。
  const seen = new Set<string>();
  items = items.filter((i) => (seen.has(i.href) ? false : (seen.add(i.href), true)));
  // 並び替え（order に載った href を前方へ、その順で）。
  if (ov?.order?.length) {
    const rank = (h: string) => { const k = ov.order!.indexOf(h); return k < 0 ? Number.MAX_SAFE_INTEGER : k; };
    items = items.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it.href) - rank(b.it.href) || a.i - b.i).map((x) => x.it);
  }
  return items;
}

const KV_NAV = "nav_overrides";
export async function getNavOverrides(ctx: Ctx): Promise<NavOverrides | null> {
  const raw = await ctx.storage.kv.get(KV_NAV);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : null; } catch { return null; }
}
export async function setNavOverrides(ctx: Ctx, ov: NavOverrides): Promise<NavOverrides> {
  const clean: NavOverrides = {
    hidden: Array.isArray(ov.hidden) ? ov.hidden.map(String) : [],
    labels: ov.labels && typeof ov.labels === "object" ? ov.labels : {},
    order: Array.isArray(ov.order) ? ov.order.map(String) : [],
  };
  await ctx.storage.kv.put(KV_NAV, JSON.stringify(clean));
  return clean;
}
