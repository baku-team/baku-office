// 庶務／名簿パーツ。名簿照会は復号PIIを返すため特権ロールのみ（§14-1）。
// データは ctx.db、復号鍵は masterKeyCtx（鍵保管は KvPort 経由＝§14-3。Worker Secret 優先）。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";
import { decryptField } from "@baku-office/shared";
import { masterKeyCtx } from "../lib/client.ts";

// 名簿は暗号化されているため復号して照合（小規模前提）。
export async function searchMembers(ctx: Ctx, a: { query: string }): Promise<string> {
  const { results } = await ctx.db.prepare("SELECT display_name,role,status FROM users WHERE status='active'").all<{ display_name: string | null; role: string; status: string }>();
  const mk = await masterKeyCtx(ctx);
  const out: string[] = [];
  for (const u of results) {
    let name = "";
    try { name = u.display_name ? await decryptField(mk, u.display_name, "member-pii") : ""; } catch { /* skip */ }
    if (!a.query || name.includes(a.query)) out.push(`・${name || "(無名)"}（${u.role}）`);
  }
  return out.length ? out.join("\n") : "該当するメンバーはいません。";
}

export const membersPart: Part = {
  id: "members",
  name: "庶務／名簿",
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
