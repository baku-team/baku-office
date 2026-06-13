import type { APIRoute } from "astro";
import { createMember } from "../../../lib/membership.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 公開HPの会員申込（認証不要）。会員管理に未払いで追加（現金/手動運用の既定）。
// 公開フォームを show_join のページが出している前提。スパム対策は IP レート制限（無料枠KV）。将来 Turnstile。
export const POST: APIRoute = async ({ request, locals }) => {
  // IPレート制限（P2-4）：公開フォーム経由の会員レコード量産を抑止（apply.ts と同様の方式）。
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rlKey = `joinrl:${ip}`;
  const cur = Number((await env.LICENSE.get(rlKey)) ?? "0");
  if (cur >= 10) return json({ error: "短時間に申込が集中しています。時間をおいて再度お試しください。" }, 429);
  await env.LICENSE.put(rlKey, String(cur + 1), { expirationTtl: 3600 });
  const b = (await request.json().catch(() => ({}))) as { name?: string; contact?: string };
  const name = (b.name ?? "").trim();
  if (!name) return json({ error: "お名前が必要です" }, 400);
  if (name.length > 100) return json({ error: "入力が長すぎます" }, 400);
  await createMember(env, { name, contact: (b.contact ?? "").slice(0, 200), fee_status: "unpaid", extra: "公開フォームからの申込" });
  return json({ ok: true });
};
