// 請求書管理パーツ（Pro以上）。画像/PDFから Claude マルチモーダルで請求元・金額・期日を抽出し、
// 元ファイルは files（R2/KV）に保存して file_id 参照、抽出結果は invoices テーブルへ。支払いステータス管理。
// 未払の期日接近は reminders に通知予約（drain→LINE で配信）。人間が目視確認するため UI（/invoices）を持つ。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "../lib/accounting.ts";
import { getFile, fileBelongsTo } from "../lib/storage.ts";
import { extractInvoiceData } from "../lib/media-ai.ts";
import { setReminder } from "./reminders.ts";

export type InvoiceRow = {
  id: string; owner: string; file_id: string | null; vendor: string | null; amount: number | null;
  issued_date: string | null; due_date: string | null; status: string; notes: string | null;
  source: string | null; created_at: number; updated_at: number;
};
const STATUSES = ["unpaid", "paid", "overdue", "canceled"];

// 抽出済みデータを invoices に保存。期日があれば3日前に通知予約。
export async function saveInvoice(ctx: Ctx, owner: string, d: { fileId?: string; vendor?: string; amount?: number; issued_date?: string; due_date?: string; notes?: string; source?: string }): Promise<string> {
  const id = randomId();
  const now = nowSec();
  await ctx.db.prepare(
    "INSERT INTO invoices (id,owner,file_id,vendor,amount,issued_date,due_date,status,notes,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?, 'unpaid', ?,?,?,?)",
  ).bind(id, owner, d.fileId ?? null, d.vendor ?? null, d.amount ?? null, d.issued_date ?? null, d.due_date ?? null, d.notes ?? null, d.source ?? "manual", now, now).run();
  if (d.due_date) {
    const due = new Date(d.due_date).getTime();
    if (Number.isFinite(due)) {
      const remindAt = new Date(due - 3 * 86400000).toISOString();
      await setReminder(ctx, owner, { content: `請求書「${d.vendor ?? "(請求元不明)"}」の支払期日が近づいています（期日 ${d.due_date}${d.amount ? ` / ¥${d.amount.toLocaleString()}` : ""}）`, remind_at: remindAt }).catch(() => {});
    }
  }
  return id;
}

// file_id のファイルを取得 → Claude抽出 → 保存。手動アップロード・メール添付・チャット添付の共通入口。
export async function registerInvoiceFromFile(ctx: Ctx, owner: string, fileId: string, source = "manual"): Promise<{ id?: string; vendor?: string; amount?: number; due_date?: string; error?: string }> {
  // 所有者検査（P0-1補完）。WHY: チャットの register_invoice ツールは model 指定の file_id を
  // raw getFile に渡すため、自分が保存したファイル以外を抽出できると他者ファイルのIDORになる。
  // 正規フロー（手動アップロード/チャット添付）は直前に owner 本人が保存＝created_by===owner。
  if (!(await fileBelongsTo(ctx.env, fileId, owner))) return { error: "ファイルが見つかりません。" };
  const f = await getFile(ctx.env, fileId);
  if (!f) return { error: "ファイルが見つかりません。" };
  const ex = await extractInvoiceData(ctx.env, f);
  const id = await saveInvoice(ctx, owner, { fileId, vendor: ex.vendor, amount: ex.amount, issued_date: ex.issued_date, due_date: ex.due_date, source });
  return { id, vendor: ex.vendor, amount: ex.amount, due_date: ex.due_date };
}

export async function listInvoices(ctx: Ctx, opts: { status?: string; limit?: number } = {}): Promise<InvoiceRow[]> {
  const where = ["deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (opts.status && STATUSES.includes(opts.status)) { where.push("status=?"); binds.push(opts.status); }
  binds.push(Math.min(opts.limit ?? 200, 500));
  return (await ctx.db.prepare(`SELECT * FROM invoices WHERE ${where.join(" AND ")} ORDER BY due_date IS NULL, due_date ASC LIMIT ?`).bind(...binds).all<InvoiceRow>()).results;
}

export async function setInvoiceStatus(ctx: Ctx, id: string, status: string): Promise<{ ok: boolean; error?: string }> {
  if (!STATUSES.includes(status)) return { ok: false, error: "不正なステータスです" };
  await ctx.db.prepare("UPDATE invoices SET status=?, updated_at=? WHERE id=?").bind(status, nowSec(), id).run();
  return { ok: true };
}

async function toolRegister(ctx: Ctx, owner: string, a: { file_id: string; notes?: string }): Promise<string> {
  const r = await registerInvoiceFromFile(ctx, owner, a.file_id, "chat");
  if (r.error) return r.error;
  return `請求書を登録しました：${r.vendor ?? "(請求元不明)"} / ${r.amount ? `¥${r.amount.toLocaleString()}` : "金額不明"} / 期日 ${r.due_date ?? "不明"}`;
}
async function toolListUnpaid(ctx: Ctx): Promise<string> {
  const rows = await listInvoices(ctx, { status: "unpaid", limit: 30 });
  if (!rows.length) return "未払いの請求書はありません。";
  return rows.map((r) => `・[${r.id}] ${r.vendor ?? "(不明)"} ¥${r.amount?.toLocaleString() ?? "?"} 期日 ${r.due_date ?? "未設定"}`).join("\n");
}
async function toolMarkPaid(ctx: Ctx, a: { invoice_id: string }): Promise<string> {
  const r = await setInvoiceStatus(ctx, a.invoice_id, "paid");
  return r.ok ? "請求書を支払済みにしました。" : (r.error ?? "更新に失敗しました。");
}

export const invoicesPart: Part = {
  id: "invoices",
  name: "請求書管理",
  version: "1.0.0",
  category: "会計",
  description: "請求書/領収書の画像・PDFから請求元・金額・期日を抽出して管理。未払の期日接近を通知。",
  permissions: ["db:read", "db:write", "ai", "storage:read"],
  minPlan: "pro",
  menu: [{ href: "/invoices", label: "請求書" }],
  widgets: [
    {
      id: "unpaid_invoices", title: "未払請求書",
      run: async (ctx) => {
        const r = await ctx.db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status='unpaid' AND deleted_at IS NULL").first<{ n: number }>();
        return { value: `${r?.n ?? 0} 件`, sub: "未払い" };
      },
    },
  ],
  agentTools: [
    {
      name: "register_invoice",
      description: "保存済みの請求書ファイル(file_id)から請求元・金額・期日を抽出して登録",
      parameters: { type: "object", properties: { file_id: { type: "string" }, notes: { type: "string" } }, required: ["file_id"] },
      run: (ctx, owner, _b, a) => toolRegister(ctx, owner, { file_id: String(a.file_id), notes: a.notes as string }),
    },
    {
      name: "list_unpaid_invoices",
      description: "未払いの請求書一覧（期日順）",
      parameters: { type: "object", properties: {} },
      run: (ctx) => toolListUnpaid(ctx),
    },
    {
      name: "mark_invoice_paid",
      description: "請求書を支払済みにする（invoice_id 指定）",
      parameters: { type: "object", properties: { invoice_id: { type: "string" } }, required: ["invoice_id"] },
      run: (ctx, _o, _b, a) => toolMarkPaid(ctx, { invoice_id: String(a.invoice_id) }),
    },
  ],
};
