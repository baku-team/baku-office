// 勘定科目マスタ。複式仕訳・試算表・弥生/freee 出力の基礎。既存の単式（categories/wallets）に
// account_item_id を後付けして橋渡しする。既定セットの投入はアプリ層で冪等（migrationはDDL限定）。
import { randomId } from "@baku-office/shared";

export type Major = "asset" | "liability" | "equity" | "revenue" | "expense";
export type AccountItem = {
  id: string;
  code: string;
  name: string;
  major: Major;
  normal_balance: "debit" | "credit";
  summary_group: string | null;
  freee_account_item_id: string | null;
  builtin: number;
  enabled: number;
  sort_order: number;
};

// 小規模団体向けの既定勘定科目（freee寄りの名称）。[code, name, major]。
const DEFAULTS: [string, string, Major][] = [
  ["111", "現金", "asset"],
  ["112", "普通預金", "asset"],
  ["135", "売掛金", "asset"],
  ["170", "工具器具備品", "asset"],
  ["195", "現金過不足", "asset"],
  ["311", "未払金", "liability"],
  ["315", "預り金", "liability"],
  ["401", "繰越金", "equity"],
  ["501", "売上高", "revenue"],
  ["509", "受取手数料", "revenue"],
  ["540", "雑収入", "revenue"],
  ["601", "仕入高", "expense"],
  ["611", "消耗品費", "expense"],
  ["615", "水道光熱費", "expense"],
  ["617", "通信費", "expense"],
  ["621", "支払手数料", "expense"],
  ["630", "会議費", "expense"],
  ["635", "旅費交通費", "expense"],
  ["640", "減価償却費", "expense"],
  ["690", "雑費", "expense"],
];
const normalBalanceOf = (m: Major): "debit" | "credit" => (m === "asset" || m === "expense" ? "debit" : "credit");

// 既定勘定科目を冪等投入。count==0 ガード＋code UNIQUE で並行適用も安全。
export async function ensureChartOfAccounts(env: Env): Promise<void> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM account_items").first<{ n: number }>();
  if ((row?.n ?? 0) > 0) return;
  let i = 0;
  for (const [code, name, major] of DEFAULTS) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO account_items (id,code,name,major,normal_balance,builtin,enabled,sort_order) VALUES (?,?,?,?,?,1,1,?)",
    ).bind(randomId(), code, name, major, normalBalanceOf(major), i++).run();
  }
}

// 既存の口座・科目に勘定科目を紐付け（未設定のみ）。橋渡しで借方/貸方科目を解決できるようにする。
export async function ensureCategoryAccountLinks(env: Env): Promise<void> {
  const items = await listAccountItems(env);
  const byCode = new Map(items.map((a) => [a.code, a]));
  const byName = new Map(items.map((a) => [a.name, a]));
  // 口座：現金→111／その他（銀行等）→112。
  const wallets = (await env.DB.prepare("SELECT id,type,account_item_id FROM wallets").all<{ id: string; type: string; account_item_id: string | null }>()).results;
  for (const w of wallets) {
    if (w.account_item_id) continue;
    const acc = w.type === "cash" ? byCode.get("111") : byCode.get("112");
    if (acc) await env.DB.prepare("UPDATE wallets SET account_item_id=? WHERE id=?").bind(acc.id, w.id).run();
  }
  // 科目：名称一致を優先。無ければ kind で既定（income→売上高／expense→雑費）。
  const cats = (await env.DB.prepare("SELECT id,name,kind,account_item_id FROM categories").all<{ id: string; name: string; kind: string; account_item_id: string | null }>()).results;
  for (const c of cats) {
    if (c.account_item_id) continue;
    const acc = byName.get(c.name) ?? (c.kind === "income" ? byCode.get("501") : byCode.get("690"));
    if (acc) await env.DB.prepare("UPDATE categories SET account_item_id=? WHERE id=?").bind(acc.id, c.id).run();
  }
}

export async function listAccountItems(env: Env, opts?: { enabledOnly?: boolean }): Promise<AccountItem[]> {
  const where = opts?.enabledOnly ? "WHERE enabled=1" : "";
  return (await env.DB.prepare(`SELECT * FROM account_items ${where} ORDER BY sort_order, code`).all<AccountItem>()).results;
}
export async function getAccountItem(env: Env, id: string): Promise<AccountItem | null> {
  return env.DB.prepare("SELECT * FROM account_items WHERE id=?").bind(id).first<AccountItem>();
}
export async function getAccountItemByCode(env: Env, code: string): Promise<AccountItem | null> {
  return env.DB.prepare("SELECT * FROM account_items WHERE code=?").bind(code).first<AccountItem>();
}
