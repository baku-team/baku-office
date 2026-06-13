// 庶務／名簿パーツ。名簿照会は復号PIIを返すため特権ロールのみ（§14-1）。
// 復号鍵の解決は特権側（identity Port）に閉じる＝パーツは members:read で listMemberNames のみ使う（env/鍵に触れない）。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";

// 名簿は暗号化PII。identity Port が復号して返す（members:read 権限が必要）。
export async function searchMembers(ctx: Ctx, a: { query: string }): Promise<string> {
  const members = await ctx.identity.listMemberNames();
  const out = members
    .filter((m) => !a.query || m.name.includes(a.query))
    .map((m) => `・${m.name || "(無名)"}（${m.role}）`);
  return out.length ? out.join("\n") : "該当するメンバーはいません。";
}

export const membersPart: Part = {
  id: "members",
  name: "庶務／名簿",
  version: "1.0.0",
  category: "庶務",
  description: "会員名簿（暗号化PII）の照会。特権ロールのみ。",
  permissions: ["db:read", "members:read"],
  menu: [{ href: "/membership", label: "会員管理" }],
  widgets: [
    { id: "members_count", title: "登録メンバー", run: async (ctx) => {
      const r = await ctx.db.first<{ n: number }>("SELECT count(*) AS n FROM users WHERE status='active'");
      return { value: String(r?.n ?? 0) + " 名", sub: "アクティブ会員" };
    } },
  ],
  agentTools: [
    {
      name: "search_members",
      description: "メンバー（名簿）を検索",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      requiredRole: ["admin", "accounting", "clerical"],
      run: (ctx, _owner, _baseUrl, a) => searchMembers(ctx, { query: String(a.query ?? "") }),
    },
  ],
};
