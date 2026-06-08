// A2A 公開アクション：ノーコード宣言型（read専用）＋アプリアクション参照の一元管理・解決・実行。
// すべて参照のみ・組織スコープ・LIMIT。暗号化PII列は許可表に含めない。
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "./client.ts";
import { searchKnowledge } from "../parts/knowledge.ts";

export type ActionScope = "common" | "conn" | "group";
export type ActionRow = { id: string; name: string; kind: "app" | "decl"; spec: string; scope: ActionScope; target: string; enabled: number; created_at: number };

// ノーコード・テンプレ種類（UI 表示用）。
export const DECL_TYPES: { type: string; label: string; hint: string }[] = [
  { type: "profile", label: "組織プロフィール参照", hint: "団体の基本情報・紹介・リンクを返す" },
  { type: "knowledge", label: "ナレッジ検索", hint: "引数 query で組織ナレッジを検索" },
  { type: "db", label: "DB（テーブル）参照", hint: "許可テーブルの選んだ列を read-only で返す" },
  { type: "files", label: "書類（取込資料）一覧", hint: "取り込み済み資料のメタ一覧を返す" },
  { type: "progress", label: "タスク・進捗参照", hint: "組織共有(承認済)のタスク/予定を返す" },
];

// DB 参照テンプレの安全許可表（暗号化PII列は含めない）。これ以外のテーブル/列は選べない。
export const DB_ALLOW: Record<string, string[]> = {
  wallets: ["name", "type", "opening_balance", "sort_order"],
  categories: ["name", "kind"],
  transactions: ["date", "kind", "amount"],
  imported_items: ["title", "source", "mime", "size", "imported_at"],
};

const clampLimit = (n: unknown) => Math.max(1, Math.min(200, Number(n) || 50));

// 組織プロフィール（KV）。
export async function getOrgProfile(ctx: Ctx): Promise<Record<string, unknown>> {
  const raw = await ctx.storage.kv.get("org_profile");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
export async function setOrgProfile(ctx: Ctx, obj: unknown): Promise<Record<string, unknown>> {
  const o = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
  await ctx.storage.kv.put("org_profile", JSON.stringify(o));
  return o;
}

// ノーコード宣言アクションの実行（read専用）。
export async function runDeclAction(ctx: Ctx, type: string, config: Record<string, unknown>, args: Record<string, unknown>): Promise<unknown> {
  if (type === "profile") return getOrgProfile(ctx);
  if (type === "knowledge") return searchKnowledge(ctx, { query: String(args.query ?? config.query ?? "") });
  if (type === "files") {
    const limit = clampLimit(config.limit);
    const { results } = await ctx.db.prepare("SELECT title,source,mime,size,imported_at FROM imported_items ORDER BY imported_at DESC LIMIT ?").bind(limit).all();
    return results;
  }
  if (type === "progress") {
    const limit = clampLimit(config.limit);
    const kind = String(config.kind ?? "");
    const sql = "SELECT type,title,date,due_at,status FROM personal_items WHERE share_scope='org' AND review_status='approved'" + (kind ? " AND type=?" : "") + " ORDER BY created_at DESC LIMIT ?";
    const stmt = kind ? ctx.db.prepare(sql).bind(kind, limit) : ctx.db.prepare(sql).bind(limit);
    return (await stmt.all()).results;
  }
  if (type === "db") {
    const table = String(config.table ?? "");
    const allow = DB_ALLOW[table];
    if (!allow) throw new Error("許可されていないテーブルです");
    const cols = (Array.isArray(config.columns) ? config.columns.map(String) : []).filter((c) => allow.includes(c));
    if (!cols.length) throw new Error("公開する列が選ばれていません");
    const limit = clampLimit(config.limit);
    let where = table === "transactions" ? " WHERE deleted_at IS NULL" : "";
    const binds: unknown[] = [];
    const fc = String(config.filterColumn ?? "");
    if (fc && allow.includes(fc) && config.filterValue !== undefined) { where += (where ? " AND " : " WHERE ") + `${fc}=?`; binds.push(config.filterValue); }
    binds.push(limit);
    const sql = `SELECT ${cols.join(",")} FROM ${table}${where} LIMIT ?`;
    return (await ctx.db.prepare(sql).bind(...binds).all()).results;
  }
  throw new Error("未知のアクション種別です");
}

// ===== 公開アクション定義 CRUD（D1 a2a_actions） =====
export async function listActions(ctx: Ctx): Promise<ActionRow[]> {
  return (await ctx.db.prepare("SELECT id,name,kind,spec,scope,target,enabled,created_at FROM a2a_actions ORDER BY created_at DESC").all<ActionRow>()).results;
}
export async function createAction(ctx: Ctx, a: { name: string; kind: "app" | "decl"; spec: unknown; scope: ActionScope; target?: string }): Promise<string> {
  const id = randomId(8);
  await ctx.db.prepare("INSERT INTO a2a_actions (id,name,kind,spec,scope,target,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)")
    .bind(id, a.name, a.kind, JSON.stringify(a.spec ?? {}), a.scope, a.target ?? "", nowSec()).run();
  return id;
}
export async function updateAction(ctx: Ctx, id: string, a: { name?: string; spec?: unknown; scope?: ActionScope; target?: string; enabled?: boolean }): Promise<void> {
  const cur = await ctx.db.prepare("SELECT name,spec,scope,target,enabled FROM a2a_actions WHERE id=?").bind(id).first<{ name: string; spec: string; scope: string; target: string; enabled: number }>();
  if (!cur) return;
  await ctx.db.prepare("UPDATE a2a_actions SET name=?, spec=?, scope=?, target=?, enabled=? WHERE id=?")
    .bind(a.name ?? cur.name, a.spec !== undefined ? JSON.stringify(a.spec) : cur.spec, a.scope ?? cur.scope, a.target ?? cur.target, a.enabled === undefined ? cur.enabled : (a.enabled ? 1 : 0), id).run();
}
export async function deleteAction(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.prepare("DELETE FROM a2a_actions WHERE id=?").bind(id).run();
}

// 受信時の解決：公開名＋スコープ（common ∪ group:target=groupId ∪ conn:target=from）で1件取得。
export async function resolveAction(ctx: Ctx, name: string, opts: { groupId?: string; from?: string }): Promise<ActionRow | null> {
  const rows = (await ctx.db.prepare("SELECT id,name,kind,spec,scope,target,enabled,created_at FROM a2a_actions WHERE name=? AND enabled=1").bind(name).all<ActionRow>()).results;
  for (const r of rows) {
    if (r.scope === "common") return r;
    if (opts.groupId && r.scope === "group" && r.target === opts.groupId) return r;
    if (!opts.groupId && r.scope === "conn" && r.target === opts.from) return r;
  }
  return null;
}

// 解決済みアクションの実行（app→ctx.apps.call / decl→runDeclAction）。
export async function runResolvedAction(ctx: Ctx, row: ActionRow, args: Record<string, unknown>): Promise<unknown> {
  const spec = JSON.parse(row.spec || "{}");
  if (row.kind === "app") return ctx.apps.call(String(spec.appId ?? ""), String(spec.action ?? ""), args);
  return runDeclAction(ctx, String(spec.type ?? ""), (spec.config ?? {}) as Record<string, unknown>, args);
}
