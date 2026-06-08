// ホーム（ダッシュボード）のセクション構成（団体ごと・実行時）。
// 「お知らせ」は固定で最上部・対象外。その他のセクションを並べ替え・非表示できる（nav.ts と同型）。
import type { Ctx } from "./ports.ts";

export type HomeSection = { id: string; label: string };
export type HomeLayout = { order?: string[]; hidden?: string[] };

// 並べ替え/非表示できる configurable セクション（お知らせは固定のため含めない）。
export const HOME_SECTIONS: HomeSection[] = [
  { id: "summary", label: "サマリー（残高・プラン等）" },
  { id: "widgets", label: "アプリの状況（ウィジェット）" },
  { id: "storage", label: "ストレージ使用量" },
  { id: "quicklinks", label: "できること（リンク）" },
];

// レイアウトを適用して描画順のセクション id 配列を返す（order を前方へ・hidden を除外・未知/新規は末尾）。
export function orderedSections(layout: HomeLayout | null): string[] {
  const hidden = new Set(layout?.hidden ?? []);
  const all = HOME_SECTIONS.map((s) => s.id);
  const order = layout?.order ?? [];
  const rank = (id: string) => { const k = order.indexOf(id); return k < 0 ? Number.MAX_SAFE_INTEGER : k; };
  return all
    .filter((id) => !hidden.has(id))
    .map((id, i) => ({ id, i }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
    .map((x) => x.id);
}

const KV_HOME = "home_layout";
export async function getHomeLayout(ctx: Ctx): Promise<HomeLayout | null> {
  const raw = await ctx.storage.kv.get(KV_HOME);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : null; } catch { return null; }
}
export async function setHomeLayout(ctx: Ctx, layout: HomeLayout): Promise<HomeLayout> {
  const known = new Set(HOME_SECTIONS.map((s) => s.id));
  const clean: HomeLayout = {
    order: (Array.isArray(layout.order) ? layout.order.map(String) : []).filter((id) => known.has(id)),
    hidden: (Array.isArray(layout.hidden) ? layout.hidden.map(String) : []).filter((id) => known.has(id)),
  };
  await ctx.storage.kv.put(KV_HOME, JSON.stringify(clean));
  return clean;
}
