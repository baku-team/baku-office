// アプリ内通知（migration 0021）。自動取込(owner="org")など LINE 未紐付けスコープの期日通知等を
// DB に積み、ヘッダのベル／/api/notifications で表示・既読化する。ctx.db 経由でポータブル。
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";

export type NotificationRow = { id: string; kind: string; body: string; link: string | null; read_at: number | null; created_at: number };

export async function addNotification(ctx: Ctx, n: { owner: string; kind: string; body: string; link?: string }): Promise<void> {
  await ctx.db.run("INSERT INTO notifications (id,owner,kind,body,link,created_at) VALUES (?,?,?,?,?,?)",
    [randomId(), n.owner, n.kind, n.body, n.link ?? null, nowSec()]);
}

export async function listNotifications(ctx: Ctx, owner: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationRow[]> {
  const where = opts.unreadOnly ? "owner=? AND read_at IS NULL" : "owner=?";
  return await ctx.db.all<NotificationRow>(`SELECT id,kind,body,link,read_at,created_at FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
    [owner, Math.min(opts.limit ?? 30, 100)]);
}

export async function countUnread(ctx: Ctx, owner: string): Promise<number> {
  const r = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE owner=? AND read_at IS NULL", [owner]);
  return r?.n ?? 0;
}

// id 指定で1件、未指定で owner の全未読を既読化。
export async function markNotificationsRead(ctx: Ctx, owner: string, id?: string): Promise<void> {
  const now = nowSec();
  if (id) await ctx.db.run("UPDATE notifications SET read_at=? WHERE owner=? AND id=? AND read_at IS NULL", [now, owner, id]);
  else await ctx.db.run("UPDATE notifications SET read_at=? WHERE owner=? AND read_at IS NULL", [now, owner]);
}

// 任意 Webhook（Discord 互換）へのプッシュ。content/text 両キーを送り Discord/Slack 双方で表示可能にする。
export async function pushWebhook(url: string, text: string): Promise<void> {
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, text }) });
}
