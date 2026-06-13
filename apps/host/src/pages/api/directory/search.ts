import type { APIRoute } from "astro";
import { atLeast } from "@baku-office/shared";
import { callerFromToken } from "../../../lib/registry.ts";
import { searchEntries } from "../../../lib/directory.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 公開ディレクトリ検索（Plus 以上）。クエリ埋め込みは client が生成して送る（ホストはAI非依存）。
export const POST: APIRoute = async ({ request }) => {
  const b = (await request.json().catch(() => ({}))) as { token?: string; query?: string; queryEmbedding?: number[] | null; tags?: string[]; limit?: number };
  const caller = await callerFromToken(env, b.token);
  if (!caller) return json({ error: "有効なライセンスが必要" }, 401);
  if (!atLeast(caller.entitlement, "plus")) return json({ error: "検索は Plus 以上で利用できます" }, 402);
  const results = await searchEntries(env, {
    query: b.query ? String(b.query) : undefined,
    queryEmbedding: Array.isArray(b.queryEmbedding) ? b.queryEmbedding : null,
    tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
    limit: Math.min(50, Number(b.limit) || 20),
  });
  // 自団体は検索結果から除外。
  return json({ ok: true, results: results.filter((r) => r.license_id !== caller.licenseId) });
};
