// メモパーツ（個人メモ）。データ操作は ctx.db 経由。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "../lib/accounting.ts";

export async function saveMemo(ctx: Ctx, owner: string, a: { title: string; body?: string }): Promise<string> {
  await ctx.db.prepare("INSERT INTO personal_items (id,owner_user_id,type,title,body,share_scope,review_status,created_at) VALUES (?,?,?,?,?,'personal','none',?)")
    .bind(randomId(), owner, "memo", a.title, a.body ?? null, nowSec()).run();
  return `メモを保存：${a.title}`;
}

export const memoPart: Part = {
  id: "memo",
  name: "メモ",
  version: "1.0.0",
  category: "庶務",
  description: "個人メモの保存。",
  permissions: ["db:write"],
  menu: [{ href: "/personal", label: "個人" }],
  agentTools: [
    {
      name: "save_memo",
      description: "メモを保存",
      parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] },
      run: (ctx, owner, _baseUrl, a) => saveMemo(ctx, owner, { title: String(a.title), body: a.body ? String(a.body) : undefined }),
    },
  ],
};
