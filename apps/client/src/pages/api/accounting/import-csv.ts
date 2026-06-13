import type { APIRoute } from "astro";
import { requireOrgAdmin, getSession } from "../../../lib/auth.ts";
import { createTx, currentPeriod, ensureSeed, findOrCreateCategory, listWallets } from "../../../lib/accounting.ts";
import { parseTransactionsCsv } from "../../../lib/tx-import.ts";
import { audit } from "../../../lib/storage.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 明細CSVの取込。admin+org のみ（tx.ts と同基準）。
// _action=preview：解析結果だけ返す（登録しない）。_action=import：取引として一括登録。
export const POST: APIRoute = async ({ request }) => {
  if (!(await requireOrgAdmin(env, request))) return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; csv?: string; wallet_id?: string };
  const csv = String(b.csv ?? "");
  if (csv.trim().length < 3) return json({ error: "CSV の内容が空です" }, 400);
  const parsed = parseTransactionsCsv(csv);

  if (b._action === "preview") {
    return json({ ok: true, rows: parsed.rows.slice(0, 100), total: parsed.total, skipped: parsed.skipped, warnings: parsed.warnings });
  }
  if (b._action === "import") {
    if (!b.wallet_id) return json({ error: "取り込み先の口座を選んでください" }, 400);
    if (!parsed.rows.length) return json({ error: "取り込める明細がありませんでした", warnings: parsed.warnings }, 400);
    await ensureSeed(env);
    const period = await currentPeriod(env);
    if (!period) return json({ error: "会計期がありません" }, 400);
    const wallets = await listWallets(env);
    if (!wallets.some((w) => w.id === b.wallet_id)) return json({ error: "口座が見つかりません" }, 400);
    // 取込分は後で見直せるよう、種別ごとに専用カテゴリ（要確認）へ寄せる。
    const incCat = await findOrCreateCategory(env, "口座取込（収入・要確認）", "income");
    const expCat = await findOrCreateCategory(env, "口座取込（支出・要確認）", "expense");
    let imported = 0;
    for (const r of parsed.rows) {
      await createTx(env, {
        fiscal_period_id: period.id, date: r.date, wallet_id: String(b.wallet_id), kind: r.kind,
        category_id: r.kind === "income" ? incCat : expCat, amount: r.amount,
        description: r.description || "（明細取込）", counter_wallet_id: null,
      });
      imported++;
    }
    const uid = (await getSession(env, request).catch(() => null))?.uid ?? "admin";
    await audit(env, uid, "accounting.import_csv", `wallet=${b.wallet_id} imported=${imported} skipped=${parsed.skipped}`);
    return json({ ok: true, imported, skipped: parsed.skipped, warnings: parsed.warnings });
  }
  return json({ error: "不明な操作" }, 400);
};
