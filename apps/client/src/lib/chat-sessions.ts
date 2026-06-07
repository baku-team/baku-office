// AIチャットのセッション・履歴（セッション切替＋モデル選択）。owner スコープで分離。
import type { Ctx } from "../core/ports.ts";
import type { Turn } from "../core/ai.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";

export type ChatModelId = "gemini" | "claude" | "local";
export type SessionRow = { id: string; title: string | null; model: string | null; updated_at: number };
export type MsgRow = { role: string; content: string; created_at: number };

export async function listSessions(ctx: Ctx, owner: string): Promise<SessionRow[]> {
  const { results } = await ctx.db.prepare("SELECT id,title,model,updated_at FROM chat_sessions WHERE owner=? ORDER BY updated_at DESC LIMIT 50").bind(owner).all<SessionRow>();
  return results;
}
export async function createSession(ctx: Ctx, owner: string, model?: string): Promise<string> {
  const id = randomId();
  const now = nowSec();
  await ctx.db.prepare("INSERT INTO chat_sessions (id,owner,title,model,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .bind(id, owner, null, model ?? null, now, now).run();
  return id;
}
export async function deleteSession(ctx: Ctx, owner: string, id: string): Promise<void> {
  // owner 検証してから削除（他人のセッションは消せない）。
  const s = await ctx.db.prepare("SELECT id FROM chat_sessions WHERE id=? AND owner=?").bind(id, owner).first();
  if (!s) return;
  await ctx.db.prepare("DELETE FROM chat_messages WHERE session_id=?").bind(id).run();
  await ctx.db.prepare("DELETE FROM chat_sessions WHERE id=?").bind(id).run();
}
// owner 所有のセッションのみ取得（なければ null）。
export async function ownedSession(ctx: Ctx, owner: string, id: string): Promise<{ id: string; model: string | null } | null> {
  return (await ctx.db.prepare("SELECT id,model FROM chat_sessions WHERE id=? AND owner=?").bind(id, owner).first<{ id: string; model: string | null }>()) ?? null;
}
export async function getMessages(ctx: Ctx, sessionId: string): Promise<MsgRow[]> {
  const { results } = await ctx.db.prepare("SELECT role,content,created_at FROM chat_messages WHERE session_id=? ORDER BY created_at LIMIT 200").bind(sessionId).all<MsgRow>();
  return results;
}
export async function appendMessage(ctx: Ctx, sessionId: string, role: "user" | "assistant", content: string): Promise<void> {
  await ctx.db.prepare("INSERT INTO chat_messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)")
    .bind(randomId(), sessionId, role, content, nowSec()).run();
  await ctx.db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").bind(nowSec(), sessionId).run();
}
// 初回ユーザー発話をタイトルに（未設定時のみ）。
export async function ensureTitle(ctx: Ctx, sessionId: string, firstText: string): Promise<void> {
  await ctx.db.prepare("UPDATE chat_sessions SET title=? WHERE id=? AND (title IS NULL OR title='')")
    .bind(firstText.slice(0, 40), sessionId).run();
}
// 履歴(直近N) → モデル中立 Turn[]（道具呼び出しは保存しないため user/assistant テキストのみ）。
export function toTurns(msgs: MsgRow[], limit = 20): Turn[] {
  return msgs.slice(-limit).map((m) => m.role === "assistant"
    ? ({ role: "assistant", text: m.content } as Turn)
    : ({ role: "user", text: m.content } as Turn));
}
