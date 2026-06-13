// メモパーツ（個人メモ）。データ操作は ctx.db 経由。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "../lib/accounting.ts";

export async function saveMemo(ctx: Ctx, owner: string, a: { title: string; body?: string }): Promise<string> {
  await ctx.db.run("INSERT INTO personal_items (id,owner_user_id,type,title,body,share_scope,review_status,created_at) VALUES (?,?,?,?,?,'personal','none',?)",
    [randomId(), owner, "memo", a.title, a.body ?? null, nowSec()]);
  return `メモを保存：${a.title}`;
}

// 領収書（経費精算）を個人の記録として作成し、そのまま組織へ申請（承認待ち）にする。
// 1操作で「作成＋共有申請」まで行う＝AIが「申請して」に対し実際に申請を完了できる。
export async function submitReceipt(ctx: Ctx, owner: string, a: { title: string; amount?: number; date?: string; body?: string }): Promise<string> {
  const amount = a.amount != null && Number.isFinite(a.amount) && a.amount > 0 ? Math.round(a.amount) : null;
  await ctx.db.run(
    "INSERT INTO personal_items (id,owner_user_id,type,title,body,amount,date,share_scope,review_status,created_at) VALUES (?,?,?,?,?,?,?,'org','pending',?)",
    [randomId(), owner, "receipt", a.title, a.body ?? null, amount, a.date ?? null, nowSec()],
  );
  return `領収書「${a.title}」${amount != null ? `（¥${amount.toLocaleString("ja-JP")}）` : ""}を申請しました（組織の承認待ち）。承認の状況は「個人の作業領域」、管理者は承認画面で確認できます。`;
}

export const memoPart: Part = {
  id: "memo",
  name: "メモ",
  version: "1.0.0",
  category: "庶務",
  description: "個人メモの保存。",
  permissions: ["db:write"],
  menu: [{ href: "/personal", label: "個人" }],
  agentTools: [
    {
      name: "save_memo",
      description: "メモを保存",
      parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] },
      run: (ctx, owner, _baseUrl, a) => saveMemo(ctx, owner, { title: String(a.title), body: a.body ? String(a.body) : undefined }),
    },
    {
      name: "submit_receipt",
      description: "領収書（経費精算）を作成し、そのまま組織へ申請（承認待ち）にする。『領収書を申請して』に対応。title必須、amount(円)・date(YYYY-MM-DD)・memoは任意。",
      parameters: { type: "object", properties: { title: { type: "string", description: "領収書の内容・宛名など" }, amount: { type: "number", description: "金額（円）" }, date: { type: "string", description: "日付 YYYY-MM-DD" }, body: { type: "string", description: "メモ・補足" } }, required: ["title"] },
      run: (ctx, owner, _baseUrl, a) => submitReceipt(ctx, owner, { title: String(a.title), amount: a.amount != null ? Number(a.amount) : undefined, date: a.date ? String(a.date) : undefined, body: a.body ? String(a.body) : undefined }),
    },
  ],
};
