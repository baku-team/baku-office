// エージェントのツール群（設計書 付録B：既存エージェント→内部APIマッピング）。
// 新データモデル（personal_items / knowledge / reminders / users）への純データ操作。LLMから関数として呼ばれる。
import { randomId, decryptField } from "@baku-office/shared";
import { masterKey } from "./client.ts";
import { nowSec } from "./accounting.ts";

// owner は line:<userId> 等。エージェント記録は個人スコープ（承認で組織へ）。
export async function recordExpense(env: Env, owner: string, a: { amount: number; title: string; date?: string }): Promise<string> {
  await env.DB.prepare("INSERT INTO personal_items (id,owner_user_id,type,title,amount,date,share_scope,review_status,created_at) VALUES (?,?,?,?,?,?,'personal','none',?)")
    .bind(randomId(), owner, "receipt", a.title, Math.round(a.amount), a.date ?? new Date().toISOString().slice(0, 10), nowSec()).run();
  return `領収書を記録：${a.title} ¥${Math.round(a.amount).toLocaleString("ja-JP")}（個人→組織へ共有で会計申請）`;
}
export async function saveMemo(env: Env, owner: string, a: { title: string; body?: string }): Promise<string> {
  await env.DB.prepare("INSERT INTO personal_items (id,owner_user_id,type,title,body,share_scope,review_status,created_at) VALUES (?,?,?,?,?,'personal','none',?)")
    .bind(randomId(), owner, "memo", a.title, a.body ?? null, nowSec()).run();
  return `メモを保存：${a.title}`;
}
export async function listExpenses(env: Env, owner: string): Promise<string> {
  const { results } = await env.DB.prepare("SELECT title,amount FROM personal_items WHERE owner_user_id=? AND type='receipt' ORDER BY created_at DESC LIMIT 10").bind(owner).all<{ title: string; amount: number | null }>();
  if (!results.length) return "領収書の記録はありません。";
  return results.map((r) => `・${r.title} ¥${(r.amount ?? 0).toLocaleString("ja-JP")}`).join("\n");
}
export async function setReminder(env: Env, owner: string, a: { content: string; remind_at: string }): Promise<string> {
  const at = Math.floor(new Date(a.remind_at).getTime() / 1000);
  if (!Number.isFinite(at)) return "日時を解釈できませんでした（例：2026-06-20T10:00）。";
  await env.DB.prepare("INSERT INTO reminders (id,owner,content,remind_at,done,created_at) VALUES (?,?,?,?,0,?)")
    .bind(randomId(), owner, a.content, at, nowSec()).run();
  return `リマインダー設定：${a.remind_at} に「${a.content}」`;
}
export async function listReminders(env: Env, owner: string): Promise<string> {
  const { results } = await env.DB.prepare("SELECT content,remind_at FROM reminders WHERE owner=? AND done=0 ORDER BY remind_at LIMIT 10").bind(owner).all<{ content: string; remind_at: number }>();
  if (!results.length) return "未配信のリマインダーはありません。";
  return results.map((r) => `・${new Date(r.remind_at * 1000).toISOString().slice(0, 16).replace("T", " ")} ${r.content}`).join("\n");
}
export async function saveKnowledge(env: Env, owner: string, a: { title: string; body: string }): Promise<string> {
  await env.DB.prepare("INSERT INTO knowledge (id,title,body,file_ref,tags,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(randomId(), a.title, a.body, null, "agent", owner, nowSec()).run();
  return `ナレッジを保存：${a.title}`;
}
export async function searchKnowledge(env: Env, a: { query: string }): Promise<string> {
  const q = `%${a.query}%`;
  const { results } = await env.DB.prepare("SELECT title,body FROM knowledge WHERE deleted_at IS NULL AND (title LIKE ? OR body LIKE ?) ORDER BY created_at DESC LIMIT 5").bind(q, q).all<{ title: string; body: string | null }>();
  if (!results.length) return "該当するナレッジは見つかりませんでした。";
  return results.map((r) => `■ ${r.title}\n${(r.body ?? "").slice(0, 200)}`).join("\n\n");
}
// 名簿は暗号化されているため復号して照合（小規模前提）。
export async function searchMembers(env: Env, a: { query: string }): Promise<string> {
  const { results } = await env.DB.prepare("SELECT display_name,role,status FROM users WHERE status='active'").all<{ display_name: string | null; role: string; status: string }>();
  const mk = masterKey(env);
  const out: string[] = [];
  for (const u of results) {
    let name = "";
    try { name = u.display_name ? await decryptField(mk, u.display_name, "member-pii") : ""; } catch { /* skip */ }
    if (!a.query || name.includes(a.query)) out.push(`・${name || "(無名)"}（${u.role}）`);
  }
  return out.length ? out.join("\n") : "該当するメンバーはいません。";
}

// 期限が来た未配信リマインダーを取り出し、配信済みにする（drain / 遅延配信で使用）。
export async function dueReminders(env: Env, owner?: string): Promise<{ id: string; owner: string; content: string }[]> {
  const now = nowSec();
  const sql = owner
    ? "SELECT id,owner,content FROM reminders WHERE done=0 AND remind_at<=? AND owner=? ORDER BY remind_at LIMIT 20"
    : "SELECT id,owner,content FROM reminders WHERE done=0 AND remind_at<=? ORDER BY remind_at LIMIT 50";
  const stmt = owner ? env.DB.prepare(sql).bind(now, owner) : env.DB.prepare(sql).bind(now);
  const { results } = await stmt.all<{ id: string; owner: string; content: string }>();
  return results;
}
export async function markReminderDone(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE reminders SET done=1 WHERE id=?").bind(id).run();
}
