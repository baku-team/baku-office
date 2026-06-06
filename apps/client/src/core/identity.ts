// Identity Port（移植性アーキ §3 横断・§14-2）。会員/ロール解決とローカル認証を抽象化。
// localIdentity は ctx.db のみに依存＝CF(D1) でも Node(SQLite)・Profile C でも同一コードで動く。
import type { Ctx } from "./ports.ts";
import type { Role } from "@baku-office/shared";
import { verifyPassword } from "../lib/users.ts";

export interface IdentityPort {
  // 外部ID（LINE/Discord の userId 等）→ 会員。エージェント受け口の会員限定・ロール検査に使う（§14-1/14-2）。
  memberOf(type: string, externalId: string): Promise<{ id: string; role: Role; status: string } | null>;
  roleOf(type: string, externalId: string): Promise<Role | null>;
  // ローカル認証（pass）。Profile C のログイン手段（§6 Profile C）。
  authenticate(loginId: string, password: string): Promise<{ id: string; role: Role; status: string } | null>;
}

export function localIdentity(ctx: Ctx): IdentityPort {
  const memberOf = async (type: string, externalId: string) => {
    const idn = await ctx.db.prepare("SELECT user_id FROM identities WHERE type=? AND external_id=?").bind(type, externalId).first<{ user_id: string }>();
    if (!idn) return null;
    return (await ctx.db.prepare("SELECT id, role, status FROM users WHERE id=?").bind(idn.user_id).first<{ id: string; role: Role; status: string }>()) ?? null;
  };
  return {
    memberOf,
    roleOf: async (type, externalId) => (await memberOf(type, externalId))?.role ?? null,
    authenticate: async (loginId, password) => {
      const idn = await ctx.db.prepare("SELECT user_id, password_hash FROM identities WHERE type='local' AND external_id=?")
        .bind(loginId).first<{ user_id: string; password_hash: string | null }>();
      if (!idn?.password_hash || !(await verifyPassword(idn.password_hash, password))) return null;
      return (await ctx.db.prepare("SELECT id, role, status FROM users WHERE id=? AND status='active'").bind(idn.user_id).first<{ id: string; role: Role; status: string }>()) ?? null;
    },
  };
}
