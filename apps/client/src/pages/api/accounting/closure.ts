import type { APIRoute } from "astro";
import { requireOrgAdmin } from "../../../lib/auth.ts";
import { currentPeriod, ensureSeed } from "../../../lib/accounting.ts";
import { createClosure, postCashOverShort, type ClosureKind } from "../../../lib/register.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const jstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// レジ締め（日次/月次/年度末）の記録と、差異の現金過不足調整。会計データと同基準＝admin+org のみ。
export const POST: APIRoute = async ({ request }) => {
  if (!(await requireOrgAdmin(env, request))) return json({ error: "管理者のみ" }, 403);
  await ensureSeed(env);
  const period = await currentPeriod(env);
  if (!period) return json({ error: "会計期がありません" }, 400);
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (b._action === "adjust" && typeof b.id === "string") {
    const entryId = await postCashOverShort(env, b.id, jstToday());
    if (!entryId) return json({ error: "調整できる差異がありません（差異0 or 調整済み）" }, 400);
    return json({ ok: true, entryId });
  }

  const kind = (["daily", "monthly", "year_end"].includes(String(b.kind)) ? b.kind : "daily") as ClosureKind;
  const counted = Number(b.counted_amount);
  if (!b.wallet_id || !Number.isFinite(counted) || counted < 0) return json({ error: "口座と実査額（0以上）が必要" }, 400);

  // 締め基準日とラベル：日次=今日、月次=今月末、年度末=会計期末。
  const today = jstToday();
  let asOf = today;
  let label = today;
  if (kind === "monthly") {
    const d = new Date(today + "T00:00:00Z");
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    asOf = end.toISOString().slice(0, 10);
    label = today.slice(0, 7);
  } else if (kind === "year_end") {
    asOf = period.end_date;
    label = period.name;
  }

  const r = await createClosure(env, {
    fiscal_period_id: period.id, wallet_id: String(b.wallet_id), kind, period_label: label, asOf,
    counted_amount: Math.round(counted),
  });
  return json({ ok: true, ...r });
};
