// リマインダーパーツ（移植性アーキ §4）。
// 最初の「完全ポータブル」Part：データ操作を ctx.env(D1直) ではなく ctx.db(SqlStore Port) 経由にした。
// → CF(D1) でも Node+SQLite でも同一コードで動く（Phase 3 で契約テストにより実証）。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "../lib/accounting.ts";

export async function setReminder(ctx: Ctx, owner: string, a: { content: string; remind_at: string }): Promise<string> {
  const at = Math.floor(new Date(a.remind_at).getTime() / 1000);
  if (!Number.isFinite(at)) return "日時を解釈できませんでした（例：2026-06-20T10:00）。";
  await ctx.db.prepare("INSERT INTO reminders (id,owner,content,remind_at,done,created_at) VALUES (?,?,?,?,0,?)")
    .bind(randomId(), owner, a.content, at, nowSec()).run();
  return `リマインダー設定：${a.remind_at} に「${a.content}」`;
}

export async function listReminders(ctx: Ctx, owner: string): Promise<string> {
  const { results } = await ctx.db.prepare("SELECT content,remind_at FROM reminders WHERE owner=? AND done=0 ORDER BY remind_at LIMIT 10").bind(owner).all<{ content: string; remind_at: number }>();
  if (!results.length) return "未配信のリマインダーはありません。";
  return results.map((r) => `・${new Date(r.remind_at * 1000).toISOString().slice(0, 16).replace("T", " ")} ${r.content}`).join("\n");
}

// 期限が来た未配信リマインダーを取り出す（drain / 遅延配信で使用）。
export async function dueReminders(ctx: Ctx, owner?: string): Promise<{ id: string; owner: string; content: string }[]> {
  const now = nowSec();
  const sql = owner
    ? "SELECT id,owner,content FROM reminders WHERE done=0 AND remind_at<=? AND owner=? ORDER BY remind_at LIMIT 20"
    : "SELECT id,owner,content FROM reminders WHERE done=0 AND remind_at<=? ORDER BY remind_at LIMIT 50";
  const stmt = owner ? ctx.db.prepare(sql).bind(now, owner) : ctx.db.prepare(sql).bind(now);
  const { results } = await stmt.all<{ id: string; owner: string; content: string }>();
  return results;
}

export async function markReminderDone(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.prepare("UPDATE reminders SET done=1 WHERE id=?").bind(id).run();
}

export const remindersPart: Part = {
  id: "reminders",
  name: "リマインダー",
  version: "1.0.0",
  category: "庶務",
  description: "指定日時の通知。",
  permissions: ["db:read", "db:write"],
  agentTools: [
    {
      name: "set_reminder",
      description: "指定日時にLINEへ通知",
      parameters: { type: "object", properties: { content: { type: "string" }, remind_at: { type: "string", description: "ISO日時" } }, required: ["content", "remind_at"] },
      run: (ctx, owner, _baseUrl, a) => setReminder(ctx, owner, { content: String(a.content), remind_at: String(a.remind_at) }),
    },
    {
      name: "list_reminders",
      description: "未配信リマインダー一覧",
      parameters: { type: "object", properties: {} },
      run: (ctx, owner) => listReminders(ctx, owner),
    },
  ],
};
