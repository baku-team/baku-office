// 受付箱：招待なし公開A2Aの問い合わせ/接続申請を積み、管理者が承認/拒否/ブロックする。
// inbound（受信）と directory API（管理）で共用。
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "./client.ts";

export type Inquiry = { id: string; from_license: string; from_name: string | null; action: string | null; args: string | null; message: string | null; trust: string | null; status: string; created_at: number; decided_at: number | null };

export async function isBlocked(ctx: Ctx, fromLicense: string): Promise<boolean> {
  return !!(await ctx.db.first("SELECT from_license FROM a2a_blocks WHERE from_license=?", [fromLicense]));
}
export async function addBlock(ctx: Ctx, fromLicense: string, reason?: string): Promise<void> {
  await ctx.db.run("INSERT INTO a2a_blocks (from_license,reason,created_at) VALUES (?,?,?) ON CONFLICT(from_license) DO UPDATE SET reason=excluded.reason", [fromLicense, reason ?? null, nowSec()]);
}
export async function removeBlock(ctx: Ctx, fromLicense: string): Promise<void> {
  await ctx.db.run("DELETE FROM a2a_blocks WHERE from_license=?", [fromLicense]);
}

export async function addInquiry(ctx: Ctx, i: { fromLicense: string; fromName?: string; action?: string; args?: unknown; message?: string; trust?: unknown }): Promise<string> {
  const id = randomId(8);
  await ctx.db.run(
    "INSERT INTO a2a_inquiries (id,from_license,from_name,action,args,message,trust,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)",
    [id, i.fromLicense, i.fromName ?? null, i.action ?? null, i.args !== undefined ? JSON.stringify(i.args) : null, i.message ?? null, i.trust !== undefined ? JSON.stringify(i.trust) : null, nowSec()],
  );
  return id;
}
export async function listInquiries(ctx: Ctx, status?: string): Promise<Inquiry[]> {
  const sql = "SELECT * FROM a2a_inquiries" + (status ? " WHERE status=?" : "") + " ORDER BY created_at DESC LIMIT 100";
  return await ctx.db.all<Inquiry>(sql, status ? [status] : []);
}
export async function getInquiry(ctx: Ctx, id: string): Promise<Inquiry | null> {
  return await ctx.db.first<Inquiry>("SELECT * FROM a2a_inquiries WHERE id=?", [id]);
}
export async function decideInquiry(ctx: Ctx, id: string, status: "approved" | "rejected" | "blocked"): Promise<void> {
  await ctx.db.run("UPDATE a2a_inquiries SET status=?, decided_at=? WHERE id=?", [status, nowSec(), id]);
}
