// Identity Port（移植性アーキ §3 横断・§14-2）。会員/ロール解決とローカル認証を抽象化。
// localIdentity は ctx.db のみに依存＝CF(D1) でも Node(SQLite)・Profile C でも同一コードで動く。
import type { Ctx } from "./ports.ts";
import type { Role } from "@baku-office/shared";
import { decryptField } from "@baku-office/shared";
import { verifyPassword } from "../lib/users.ts";
import { masterKeyCtx } from "../lib/client.ts";

export interface IdentityPort {
  // 外部ID（LINE/Discord の userId 等）→ 会員。エージェント受け口の会員限定・ロール検査に使う（§14-1/14-2）。
  memberOf(type: string, externalId: string): Promise<{ id: string; role: Role; status: string } | null>;
  roleOf(type: string, externalId: string): Promise<Role | null>;
  // ローカル認証（pass）。Profile C のログイン手段（§6 Profile C）。
  authenticate(loginId: string, password: string): Promise<{ id: string; role: Role; status: string } | null>;
  // 在籍会員の表示名（復号済PII）＋ロール。復号鍵の解決は特権側に閉じ、パーツは members:read で本APIのみ使う。
  listMemberNames(): Promise<{ name: string; role: string }[]>;
}

export function localIdentity(ctx: Ctx): IdentityPort {
  const memberOf = async (type: string, externalId: string) => {
    const idn = await ctx.db.first<{ user_id: string }>("SELECT user_id FROM identities WHERE type=? AND external_id=?", [type, externalId]);
    if (!idn) return null;
    return (await ctx.db.first<{ id: string; role: Role; status: string }>("SELECT id, role, status FROM users WHERE id=?", [idn.user_id])) ?? null;
  };
  return {
    memberOf,
    roleOf: async (type, externalId) => (await memberOf(type, externalId))?.role ?? null,
    listMemberNames: async () => {
      // 復号鍵は特権 ctx（buildCtx で生成した本体）に閉じる＝パーツへ env/鍵を渡さない。
      const rows = await ctx.db.all<{ display_name: string | null; role: string }>("SELECT display_name,role FROM users WHERE status='active'");
      const mk = await masterKeyCtx(ctx);
      const out: { name: string; role: string }[] = [];
      for (const u of rows) {
        let name = "";
        try { name = u.display_name ? await decryptField(mk, u.display_name, "member-pii") : ""; } catch { /* skip */ }
        out.push({ name, role: u.role });
      }
      return out;
    },
    authenticate: async (loginId, password) => {
      const idn = await ctx.db.first<{ user_id: string; password_hash: string | null }>("SELECT user_id, password_hash FROM identities WHERE type='local' AND external_id=?", [loginId]);
      if (!idn?.password_hash || !(await verifyPassword(idn.password_hash, password))) return null;
      return (await ctx.db.first<{ id: string; role: Role; status: string }>("SELECT id, role, status FROM users WHERE id=? AND status='active'", [idn.user_id])) ?? null;
    },
  };
}
