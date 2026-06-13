import type { APIRoute } from "astro";
import { currentPeriod } from "../../lib/accounting.ts";
import { getSession, canAccess } from "../../lib/auth.ts";
import { env } from "cloudflare:workers";

export const prerender = false;

// 取引明細のCSV出力（§8.1：出力はPDF/CSV）。Excelで開けるよう BOM 付き UTF-8。
export const GET: APIRoute = async ({ request, locals }) => {
  // 摘要に氏名・取引先等のPIIが入り得るため閲覧権限を必須化（admin / accounting のみ・P0-1）。
  // 本ルートはパスに "." を含み旧middlewareのログイン誘導を素通りしていた＝ルート内で必ず認可する。
  const ses = await getSession(env, request);
  if (!ses || ses.ctx !== "org" || !canAccess(ses.role, "accounting")) {
    return new Response("forbidden", { status: 403 });
  }
  const period = await currentPeriod(env);
  if (!period) return new Response("会計期がありません", { status: 400 });
  const { results } = await env.DB.prepare(
    `SELECT t.date, w.name AS wallet, t.kind, c.name AS category, t.amount, t.description, w2.name AS counter
     FROM transactions t
     JOIN wallets w ON w.id=t.wallet_id
     LEFT JOIN categories c ON c.id=t.category_id
     LEFT JOIN wallets w2 ON w2.id=t.counter_wallet_id
     WHERE t.fiscal_period_id=? AND t.deleted_at IS NULL ORDER BY t.date, t.created_at`,
  ).bind(period.id).all<{ date: string; wallet: string; kind: string; category: string | null; amount: number; description: string | null; counter: string | null }>();

  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  // 符号付金額（口座＝振替元 基準）：収入=+／支出・振替出=−。表計算での口座別集計で振替を二重計上させないため。
  const signed = (kind: string, amount: number) => (kind === "income" ? amount : -amount);
  const header = ["日付", "口座", "種別", "科目", "金額", "符号付金額", "摘要", "振替先"];
  const lines = [header.map(esc).join(",")];
  for (const r of results) {
    lines.push([r.date, r.wallet, r.kind, r.category ?? "", r.amount, signed(r.kind, r.amount), r.description ?? "", r.counter ?? ""].map(esc).join(","));
  }
  const csv = "﻿" + lines.join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="transactions_${period.name}.csv"`,
    },
  });
};
