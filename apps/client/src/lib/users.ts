// ユーザー・招待・個人アイテム（設計書§6/8.2/9）。名簿PIIは MASTER_KEY で暗号化（§10）。
import { randomId, encryptField, decryptField, type Role } from "@baku-office/shared";
import { masterKey } from "./client.ts";
import { revokeSessions } from "./auth.ts";
import { nowSec, createTx, currentPeriod } from "./accounting.ts";

export type UserRow = { id: string; display_name: string | null; role: Role; status: string; created_at: number; leave_requested_at?: number | null };

// PII暗号化（display_name）。
async function encName(env: Env, name: string): Promise<string> {
  return encryptField(await masterKey(env), name, "member-pii");
}
async function decName(env: Env, stored: string | null): Promise<string> {
  if (!stored) return "";
  try {
    return await decryptField(await masterKey(env), stored, "member-pii");
  } catch {
    return "(復号失敗)";
  }
}

// 招待コード発行（§6.3：有効期限1週間・1回・既定ロール指定）。
export async function createInvite(env: Env, issuedBy: string, defaultRole: Role): Promise<string> {
  const id = randomId();
  const code = randomId(6).toUpperCase();
  await env.DB.prepare(
    "INSERT INTO invites (id,code,issued_by,default_role,expires_at,max_uses,used_count,status) VALUES (?,?,?,?,?,1,0,'active')",
  )
    .bind(id, code, issuedBy, defaultRole, nowSec() + 7 * 86400)
    .run();
  return code;
}

// 招待コードで参加登録（§6.3手順2）：local（id/pass）or 表示名のみ。status=pending（承認待ち）。
export async function joinWithInvite(
  env: Env,
  code: string,
  name: string,
  identity: { type: "local" | "line" | "discord"; externalId?: string; password?: string },
): Promise<{ ok: boolean; error?: string }> {
  const inv = await env.DB.prepare("SELECT * FROM invites WHERE code=? AND status='active'").bind(code).first<{
    id: string; default_role: Role; expires_at: number; max_uses: number; used_count: number;
  }>();
  if (!inv) return { ok: false, error: "招待コードが無効" };
  if (nowSec() >= inv.expires_at) return { ok: false, error: "招待コードが期限切れ" };
  if (inv.used_count >= inv.max_uses) return { ok: false, error: "招待コードは使用済み" };

  const uid = randomId();
  await env.DB.prepare("INSERT INTO users (id,display_name,role,status,created_at) VALUES (?,?,?,'pending',?)")
    .bind(uid, await encName(env, name), inv.default_role, nowSec())
    .run();
  let passwordHash: string | null = null;
  if (identity.type === "local" && identity.password) {
    passwordHash = await pbkdf2Hash(identity.password);
  }
  await env.DB.prepare("INSERT INTO identities (id,user_id,type,external_id,password_hash,created_at) VALUES (?,?,?,?,?,?)")
    .bind(randomId(), uid, identity.type, identity.externalId ?? name, passwordHash, nowSec())
    .run();
  await env.DB.prepare("UPDATE invites SET used_count=used_count+1, status=CASE WHEN used_count+1>=max_uses THEN 'revoked' ELSE status END WHERE id=?")
    .bind(inv.id)
    .run();
  // §6.3手順3：組織へ通知（メール）は P5/通知で。ここではpending登録のみ。
  return { ok: true };
}

export async function listUsers(env: Env): Promise<(UserRow & { name: string })[]> {
  const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all<UserRow>();
  const out = [];
  for (const u of results) out.push({ ...u, name: await decName(env, u.display_name) });
  return out;
}
export async function approveUser(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET status='active' WHERE id=? AND status='pending'").bind(id).run();
}
export async function rejectUser(env: Env, id: string): Promise<void> {
  // 除名・脱退承認＝アカウント無効化（業務データは団体帰属のため保持）。申請フラグも解消。
  await env.DB.prepare("UPDATE users SET status='disabled', leave_requested_at=NULL WHERE id=?").bind(id).run();
  await revokeSessions(env, id); // 既存セッションを即時失効（§3-3）。
}
// 名簿から完全に削除（ユーザー行＋ログイン手段）。業務データ（団体帰属）は id 参照のまま残す。
// 取り消せないため、呼び出し側で最後の管理者・自分自身・システムユーザーをガードすること。
export async function deleteUser(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM identities WHERE user_id=?").bind(id).run();
  await env.DB.prepare("DELETE FROM users WHERE id=?").bind(id).run();
  await revokeSessions(env, id); // 残存セッションを即時失効。
}
export async function setRole(env: Env, id: string, role: Role): Promise<void> {
  await env.DB.prepare("UPDATE users SET role=? WHERE id=?").bind(role, id).run();
  await revokeSessions(env, id); // 権限変更は古いrole内包セッションを即時失効＝再ログインで新roleを反映（§3-3）。
}

// 本人による脱退申請（管理者が承認＝rejectUser で完了）。NULL=申請なし。
export async function requestLeave(env: Env, uid: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET leave_requested_at=? WHERE id=? AND status='active'").bind(nowSec(), uid).run();
}
export async function cancelLeave(env: Env, uid: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET leave_requested_at=NULL WHERE id=?").bind(uid).run();
}
// 現在アクティブな管理者の人数（最後の1人の脱退でロックアウトするのを防ぐ）。
export async function activeAdminCount(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").first<{ n: number }>();
  return r?.n ?? 0;
}

// local 認証（個人ログイン・dev）。
export async function authLocal(env: Env, loginId: string, password: string): Promise<UserRow | null> {
  const idn = await env.DB.prepare("SELECT id, user_id, password_hash FROM identities WHERE type='local' AND external_id=?")
    .bind(loginId)
    .first<{ id: string; user_id: string; password_hash: string | null }>();
  if (!idn || !idn.password_hash) return null;
  if (!(await verifyPassword(idn.password_hash, password))) return null;
  // 旧ハッシュ（無塩SHA-256）でログインできたら PBKDF2 へ透過的に再ハッシュ。
  if (!idn.password_hash.startsWith("pbkdf2$")) {
    await env.DB.prepare("UPDATE identities SET password_hash=? WHERE id=?").bind(await pbkdf2Hash(password), idn.id).run();
  }
  const u = await env.DB.prepare("SELECT * FROM users WHERE id=? AND status='active'").bind(idn.user_id).first<UserRow>();
  return u ?? null;
}

// 共有承認キュー（§9）：個人→組織で pending の個人アイテム。
export async function reviewQueue(env: Env): Promise<{ id: string; type: string; title: string; amount: number | null; owner: string; date: string | null }[]> {
  const { results } = await env.DB.prepare(
    "SELECT id,type,title,amount,owner_user_id,date FROM personal_items WHERE share_scope='org' AND review_status='pending' ORDER BY created_at",
  ).all<{ id: string; type: string; title: string | null; amount: number | null; owner_user_id: string; date: string | null }>();
  return results.map((r) => ({ id: r.id, type: r.type, title: r.title ?? "", amount: r.amount, owner: r.owner_user_id, date: r.date }));
}

// 承認：領収書は会計取引のドラフト自動生成（§9）。それ以外は組織ナレッジへ。
export async function approveItem(env: Env, id: string, reviewer: string): Promise<void> {
  const it = await env.DB.prepare("SELECT * FROM personal_items WHERE id=?").bind(id).first<{
    id: string; type: string; title: string | null; body: string | null; amount: number | null; date: string | null; owner_user_id: string;
  }>();
  if (!it) return;
  await env.DB.prepare("UPDATE personal_items SET review_status='approved', reviewed_by=?, reviewed_at=? WHERE id=?")
    .bind(reviewer, nowSec(), id)
    .run();
  if (it.type === "receipt" && it.amount) {
    // 会計取引ドラフト（科目は未設定＝後で会計担当が編集）。既定口座(現金)へ支出計上。
    const period = await currentPeriod(env);
    const wallet = await env.DB.prepare("SELECT id FROM wallets ORDER BY sort_order LIMIT 1").first<{ id: string }>();
    if (period && wallet) {
      await createTx(env, {
        fiscal_period_id: period.id,
        date: it.date ?? new Date().toISOString().slice(0, 10),
        wallet_id: wallet.id,
        kind: "expense",
        category_id: null,
        amount: it.amount,
        description: `[共有領収書] ${it.title ?? ""}`,
        counter_wallet_id: null,
      });
    }
  } else {
    await env.DB.prepare("INSERT INTO knowledge (id,title,body,file_ref,tags,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(randomId(), it.title ?? "(無題)", it.body ?? "", null, it.type, it.owner_user_id, nowSec())
      .run();
  }
}
export async function rejectItem(env: Env, id: string, reviewer: string, reason: string): Promise<void> {
  await env.DB.prepare("UPDATE personal_items SET review_status='rejected', reviewed_by=?, reviewed_at=?, reject_reason=? WHERE id=?")
    .bind(reviewer, nowSec(), reason, id)
    .run();
}

// 個人アイテム作成（個人コンテキスト）。
export async function createPersonalItem(env: Env, ownerId: string, t: { type: string; title: string; body?: string; amount?: number; date?: string }): Promise<string> {
  const id = randomId();
  await env.DB.prepare(
    "INSERT INTO personal_items (id,owner_user_id,type,title,body,amount,date,share_scope,review_status,created_at) VALUES (?,?,?,?,?,?,?,'personal','none',?)",
  )
    .bind(id, ownerId, t.type, t.title, t.body ?? null, t.amount ?? null, t.date ?? null, nowSec())
    .run();
  return id;
}
export async function shareItem(env: Env, id: string, ownerId: string): Promise<void> {
  await env.DB.prepare("UPDATE personal_items SET share_scope='org', review_status='pending' WHERE id=? AND owner_user_id=?")
    .bind(id, ownerId)
    .run();
}
export async function listMyItems(env: Env, ownerId: string): Promise<{ id: string; type: string; title: string; amount: number | null; share_scope: string; review_status: string }[]> {
  const { results } = await env.DB.prepare(
    "SELECT id,type,title,amount,share_scope,review_status FROM personal_items WHERE owner_user_id=? ORDER BY created_at DESC",
  ).bind(ownerId).all<{ id: string; type: string; title: string | null; amount: number | null; share_scope: string; review_status: string }>();
  return results.map((r) => ({ ...r, title: r.title ?? "" }));
}

// パスワードハッシュ：PBKDF2-SHA256（塩あり・ストレッチあり）。形式 "pbkdf2$<iter>$<saltB64>$<hashB64>"。
// WHY 100000上限：Cloudflare Workers の WebCrypto は PBKDF2 の iterations を 100000 までしか許可しない
// （超過すると NotSupportedError で参加/ログインのパスワード処理が500になる）。100000は同ランタイムでの最大値。
const PBKDF2_ITER = 100000;
export async function pbkdf2Hash(password: string, saltB64?: string): Promise<string> {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, base, 256);
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const sB64 = btoa(String.fromCharCode(...salt));
  return `pbkdf2$${PBKDF2_ITER}$${sB64}$${hashB64}`;
}

// 定数時間比較（タイミング攻撃対策）。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  if (stored.startsWith("pbkdf2$")) {
    const saltB64 = stored.split("$")[2];
    if (!saltB64) return false;
    return timingSafeEqual(await pbkdf2Hash(password, saltB64), stored);
  }
  // 旧形式（無塩SHA-256）。移行のため検証のみ許可（成功時 authLocal が再ハッシュ）。
  return timingSafeEqual(stored, await sha256(password));
}

async function sha256(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}
