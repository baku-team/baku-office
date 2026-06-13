import type { APIRoute } from "astro";
import { requireOrgAdmin } from "../../../lib/auth.ts";
import { currentPeriod, ensureSeed } from "../../../lib/accounting.ts";
import { createJournalEntry, softDeleteJournalEntry, type Side } from "../../../lib/journal.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 手動仕訳の登録／削除（複式）。会計データと同基準＝admin+org のみ。借貸一致は createJournalEntry が検証。
export const POST: APIRoute = async ({ request }) => {
  if (!(await requireOrgAdmin(env, request))) return json({ error: "管理者のみ" }, 403);
  await ensureSeed(env);
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (b._action === "delete" && typeof b.id === "string") {
    await softDeleteJournalEntry(env, b.id);
    return json({ ok: true });
  }

  const period = await currentPeriod(env);
  if (!period) return json({ error: "会計期がありません" }, 400);
  if (!b.date) return json({ error: "date が必要" }, 400);
  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  const lines = rawLines
    .map((l) => l as Record<string, unknown>)
    .filter((l) => (l.side === "debit" || l.side === "credit") && l.account_item_id && Number(l.amount) > 0)
    .map((l) => ({ side: l.side as Side, account_item_id: String(l.account_item_id), amount: Math.round(Number(l.amount)), memo: l.memo ? String(l.memo) : null }));
  if (lines.length < 2) return json({ error: "借方・貸方の2行以上が必要" }, 400);
  try {
    const id = await createJournalEntry(env, {
      fiscal_period_id: period.id,
      date: String(b.date),
      description: b.description ? String(b.description) : null,
      source: "manual",
      lines,
    });
    return json({ ok: true, id });
  } catch (e) {
    return json({ error: (e as Error).message || "仕訳の保存に失敗しました" }, 400);
  }
};
