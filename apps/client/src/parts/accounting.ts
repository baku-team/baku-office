// 会計パーツ（移植性アーキ §4）。データ操作は ctx.db(SqlStore Port) 経由＝CF/Node 共通。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "../lib/accounting.ts";

// owner は line:<userId> 等。エージェント記録は個人スコープ（承認で組織へ）。
export async function recordExpense(ctx: Ctx, owner: string, a: { amount: number; title: string; date?: string }): Promise<string> {
  await ctx.db.prepare("INSERT INTO personal_items (id,owner_user_id,type,title,amount,date,share_scope,review_status,created_at) VALUES (?,?,?,?,?,?,'personal','none',?)")
    .bind(randomId(), owner, "receipt", a.title, Math.round(a.amount), a.date ?? new Date().toISOString().slice(0, 10), nowSec()).run();
  return `領収書を記録：${a.title} ¥${Math.round(a.amount).toLocaleString("ja-JP")}（個人→組織へ共有で会計申請）`;
}
export async function listExpenses(ctx: Ctx, owner: string): Promise<string> {
  const { results } = await ctx.db.prepare("SELECT title,amount FROM personal_items WHERE owner_user_id=? AND type='receipt' ORDER BY created_at DESC LIMIT 10").bind(owner).all<{ title: string; amount: number | null }>();
  if (!results.length) return "領収書の記録はありません。";
  return results.map((r) => `・${r.title} ¥${(r.amount ?? 0).toLocaleString("ja-JP")}`).join("\n");
}

export const accountingPart: Part = {
  id: "accounting",
  name: "会計",
  agentTools: [
    {
      name: "record_expense",
      description: "支出/領収書を記録",
      parameters: { type: "object", properties: { amount: { type: "number" }, title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } }, required: ["amount", "title"] },
      run: (ctx, owner, _baseUrl, a) => recordExpense(ctx, owner, { amount: Number(a.amount), title: String(a.title), date: a.date ? String(a.date) : undefined }),
    },
    {
      name: "list_expenses",
      description: "記録した領収書一覧",
      parameters: { type: "object", properties: {} },
      run: (ctx, owner) => listExpenses(ctx, owner),
    },
  ],
};
