// 銀行・カード・レジ（スマレジ等）の明細CSVを取引行へ変換する。
// 完全自動の口座連携は集約サービスが要るため、まずは各サービスが出力するCSVの取込で代替する。

export type ParsedRow = { date: string; description: string; amount: number; kind: "income" | "expense" };
export type ParseResult = { rows: ParsedRow[]; total: number; skipped: number; warnings: string[] };

// RFC4180 風の最小CSVパーサ（ダブルクオート・改行・カンマのエスケープに対応）。
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// 数値化：¥ / カンマ / 空白 / 全角を除去。括弧やマイナスで負数も扱う。
function num(s: string): number {
  // ¥・カンマ（半角/全角）・空白を除去。先頭の ( は負数（会計表記）として - に。
  const t = (s ?? "").replace(/[\s,，¥]/g, "").replace(/^[（(]/, "-").replace(/[)）]/g, "").trim();
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

// 日付正規化：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / 和暦無しを許容。失敗時は空。
function normDate(s: string): string {
  const t = (s ?? "").trim();
  const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  return "";
}

const findCol = (header: string[], res: RegExp[]): number =>
  header.findIndex((h) => res.some((re) => re.test(h.trim())));

// 明細CSV → 取引行。列名（日本語/英語）から日付・内容・金額（符号付き or 入金/出金）を判定する。
export function parseTransactionsCsv(text: string): ParseResult {
  const grid = parseCsv(text);
  const warnings: string[] = [];
  if (grid.length < 2) return { rows: [], total: 0, skipped: 0, warnings: ["データ行が見つかりませんでした（1行目は見出し）。"] };
  const header = grid[0];
  const dateCol = findCol(header, [/日付|取引日|年月日|date/i]);
  const descCol = findCol(header, [/摘要|内容|お取引内容|備考|memo|description|品名|店舗/i]);
  const amtCol = findCol(header, [/^金額$|amount|利用金額|取引金額/i]);
  const inCol = findCol(header, [/入金|預入|お預り|入金額/i]);
  const outCol = findCol(header, [/出金|引出|お支払|出金額|利用額/i]);
  if (dateCol < 0) warnings.push("「日付」列が見つかりませんでした。1行目の見出しに日付の列名を入れてください。");
  if (amtCol < 0 && inCol < 0 && outCol < 0) warnings.push("「金額」または「入金/出金」の列が見つかりませんでした。");

  const rows: ParsedRow[] = [];
  let skipped = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const date = dateCol >= 0 ? normDate(r[dateCol]) : "";
    const description = (descCol >= 0 ? r[descCol] : "").trim().slice(0, 200);
    let amount = 0;
    let kind: "income" | "expense" = "expense";
    if (inCol >= 0 || outCol >= 0) {
      const inc = inCol >= 0 ? num(r[inCol]) : 0;
      const out = outCol >= 0 ? num(r[outCol]) : 0;
      if (inc > 0) { amount = inc; kind = "income"; }
      else if (out > 0) { amount = out; kind = "expense"; }
    } else if (amtCol >= 0) {
      const v = num(r[amtCol]);
      amount = Math.abs(v);
      kind = v >= 0 ? "income" : "expense";
    }
    if (!date || amount <= 0) { skipped++; continue; }
    rows.push({ date, description, amount: Math.round(amount), kind });
  }
  return { rows, total: rows.length, skipped, warnings };
}
