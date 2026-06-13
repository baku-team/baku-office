import type { APIRoute } from "astro";
import { currentPeriod } from "../../lib/accounting.ts";
import { getSession, canAccess } from "../../lib/auth.ts";
import { buildEntriesForPeriod } from "../../lib/journal.ts";
import { env } from "cloudflare:workers";

export const prerender = false;

// 弥生会計「仕訳日記帳」インポート形式のCSV出力。仕訳ベース（単式は橋渡し経由）。
// 各仕訳は借方1行/貸方1行（出納帳橋渡し・減価償却・レジ締め・手動仕訳いずれも1:1）。
// 摘要にPIIが入り得るため accounting 閲覧権限を必須化（export.csv.ts と同基準）。
export const GET: APIRoute = async ({ request }) => {
  const ses = await getSession(env, request);
  if (!ses || ses.ctx !== "org" || !canAccess(ses.role, "accounting")) {
    return new Response("forbidden", { status: 403 });
  }
  const period = await currentPeriod(env);
  if (!period) return new Response("会計期がありません", { status: 400 });
  const entries = await buildEntriesForPeriod(env, period.id);

  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const ymd = (d: string) => d.replace(/-/g, "/"); // 2026-05-01 → 2026/05/01
  // 弥生 仕訳日記帳インポート（汎用25列）。多くは空欄。税区分は「対象外」。
  const rows: string[] = [];
  let no = 1;
  for (const e of entries) {
    const deb = e.lines.find((l) => l.side === "debit");
    const cre = e.lines.find((l) => l.side === "credit");
    if (!deb || !cre) continue;
    const cols = [
      "2000",                 // 1 識別フラグ（仕訳データ）
      String(no++),           // 2 伝票番号
      "",                     // 3 決算整理仕訳
      ymd(e.date),            // 4 取引日付
      deb.name,               // 5 借方勘定科目
      "",                     // 6 借方補助科目
      "",                     // 7 借方部門
      "対象外",                // 8 借方税区分
      String(deb.amount),     // 9 借方金額
      "0",                    // 10 借方税金額
      cre.name,               // 11 貸方勘定科目
      "",                     // 12 貸方補助科目
      "",                     // 13 貸方部門
      "対象外",                // 14 貸方税区分
      String(cre.amount),     // 15 貸方金額
      "0",                    // 16 貸方税金額
      e.description ?? "",    // 17 摘要
      "",                     // 18 番号
      "",                     // 19 期日
      "",                     // 20 タイプ
      "",                     // 21 生成元
      "",                     // 22 仕訳メモ
      "",                     // 23 付箋1
      "",                     // 24 付箋2
      "no",                   // 25 調整
    ];
    rows.push(cols.map(esc).join(","));
  }
  const csv = "﻿" + rows.join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="yayoi_shiwake_${period.name}.csv"`,
    },
  });
};
