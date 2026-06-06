// 組織ナレッジパーツ。データ操作は ctx.db 経由。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "../lib/accounting.ts";

export async function saveKnowledge(ctx: Ctx, owner: string, a: { title: string; body: string }): Promise<string> {
  await ctx.db.prepare("INSERT INTO knowledge (id,title,body,file_ref,tags,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(randomId(), a.title, a.body, null, "agent", owner, nowSec()).run();
  return `ナレッジを保存：${a.title}`;
}
export async function searchKnowledge(ctx: Ctx, a: { query: string }): Promise<string> {
  const q = `%${a.query}%`;
  const { results } = await ctx.db.prepare("SELECT title,body FROM knowledge WHERE deleted_at IS NULL AND (title LIKE ? OR body LIKE ?) ORDER BY created_at DESC LIMIT 5").bind(q, q).all<{ title: string; body: string | null }>();
  if (!results.length) return "該当するナレッジは見つかりませんでした。";
  return results.map((r) => `■ ${r.title}\n${(r.body ?? "").slice(0, 200)}`).join("\n\n");
}

export const knowledgePart: Part = {
  id: "knowledge",
  name: "組織ナレッジ",
  agentTools: [
    {
      name: "save_knowledge",
      description: "組織ナレッジを保存",
      parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"] },
      run: (ctx, owner, _baseUrl, a) => saveKnowledge(ctx, owner, { title: String(a.title), body: String(a.body) }),
    },
    {
      name: "search_knowledge",
      description: "組織ナレッジを検索",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      run: (ctx, _owner, _baseUrl, a) => searchKnowledge(ctx, { query: String(a.query) }),
    },
  ],
};
