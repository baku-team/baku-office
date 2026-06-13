import type { APIRoute } from "astro";
import { createTx, softDeleteTx, currentPeriod, ensureSeed, findOrCreateCategory } from "../../lib/accounting.ts";
import { requireOrgAdmin } from "../../lib/auth.ts";
import { env } from "cloudflare:workers";

export const prerender = false;

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 取引の登録／ソフトデリート。会計データAPI（data.ts）と同基準＝admin+org のみ。
// WHY: 未認証だと第三者が取引を登録/削除でき、会計データを改竄できた。
export const POST: APIRoute = async ({ request, locals }) => {
  if (!(await requireOrgAdmin(env, request))) return json({ error: "管理者のみ" }, 403);
  await ensureSeed(env);
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (b._action === "delete" && typeof b.id === "string") {
    await softDeleteTx(env, b.id);
    return json({ ok: true });
  }

  const period = await currentPeriod(env);
  if (!period) return json({ error: "会計期がありません" }, 400);
  const kind = b.kind as "income" | "expense" | "transfer";
  const amount = Number(b.amount);
  if (!["income", "expense", "transfer"].includes(kind) || !Number.isFinite(amount) || amount <= 0) {
    return json({ error: "kind と amount(正の整数) が必要" }, 400);
  }
  if (!b.date || !b.wallet_id) return json({ error: "date と wallet_id が必要" }, 400);
  if (kind === "transfer" && !b.counter_wallet_id) return json({ error: "振替は counter_wallet_id が必要" }, 400);
  // 自口座振替は残高計算が壊れる（出納帳の排他分岐で入金側が消える）ため拒否。
  if (kind === "transfer" && b.wallet_id === b.counter_wallet_id) return json({ error: "振替元と振替先が同じ口座です" }, 400);
  // 科目：id 指定があればそれ、無ければ自由記述の名称(category_name)から検索/作成。
  let categoryId = b.category_id ? String(b.category_id) : null;
  if (kind !== "transfer" && !categoryId && typeof b.category_name === "string" && b.category_name.trim()) {
    categoryId = await findOrCreateCategory(env, b.category_name, kind as "income" | "expense");
  }
  if (kind !== "transfer" && !categoryId) return json({ error: "科目を入力してください" }, 400);

  const id = await createTx(env, {
    fiscal_period_id: period.id,
    date: String(b.date),
    wallet_id: String(b.wallet_id),
    kind,
    category_id: kind === "transfer" ? null : categoryId,
    amount: Math.round(amount),
    description: b.description ? String(b.description) : null,
    counter_wallet_id: kind === "transfer" ? String(b.counter_wallet_id) : null,
    account_item_id: kind !== "transfer" && b.account_item_id ? String(b.account_item_id) : null,
  });
  return json({ ok: true, id });
};
