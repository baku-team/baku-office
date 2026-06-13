import type { APIRoute } from "astro";
import { requireOrgAdmin } from "../../../lib/auth.ts";
import { currentPeriod, ensureSeed } from "../../../lib/accounting.ts";
import { createFixedAsset, softDeleteFixedAsset, postDepreciation, type DepMethod } from "../../../lib/fixed-assets.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 固定資産の登録／削除／減価償却の計上。会計データと同基準＝admin+org のみ。
export const POST: APIRoute = async ({ request }) => {
  if (!(await requireOrgAdmin(env, request))) return json({ error: "管理者のみ" }, 403);
  await ensureSeed(env);
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const period = await currentPeriod(env);
  if (!period) return json({ error: "会計期がありません" }, 400);

  if (b._action === "delete" && typeof b.id === "string") {
    await softDeleteFixedAsset(env, b.id);
    return json({ ok: true });
  }

  // 当期分の減価償却費を計上（1会計期1回・period_label=会計期名）。
  if (b._action === "depreciate" && typeof b.id === "string") {
    const jst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const entryId = await postDepreciation(env, b.id, period.id, period.name, jst);
    if (!entryId) return json({ error: "計上できる償却がありません（計上済み or 償却完了）" }, 400);
    return json({ ok: true, entryId });
  }

  const method = b.method === "declining_balance" ? "declining_balance" : "straight_line";
  const cost = Number(b.acquisition_cost);
  const life = Number(b.useful_life_years);
  if (!b.name || !b.acquired_date || !(cost > 0) || !(life > 0)) {
    return json({ error: "名称・取得日・取得価額・耐用年数が必要" }, 400);
  }
  const id = await createFixedAsset(env, {
    name: String(b.name),
    acquired_date: String(b.acquired_date),
    acquisition_cost: Math.round(cost),
    useful_life_years: Math.floor(life),
    method: method as DepMethod,
    residual_value: Number(b.residual_value) > 0 ? Math.round(Number(b.residual_value)) : 0,
    rate: Number(b.rate) > 0 ? Number(b.rate) : null,
    fiscal_period_id: period.id,
    notes: b.notes ? String(b.notes) : null,
  });
  return json({ ok: true, id });
};
