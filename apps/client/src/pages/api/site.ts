import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { cachedEntitlement } from "../../lib/client.ts";
import { upsertSite, deleteSite } from "../../lib/sites.ts";
import { atLeast } from "@baku-office/shared";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// HP/LP 管理（Pro以上・管理者）。作成/更新/公開切替/削除。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await cachedEntitlement(env), "pro")) return json({ error: "HP/LP は Pro プランで利用できます" }, 403);

  const b = (await request.json().catch(() => ({}))) as { _action?: string; slug?: string; title?: string; body?: string; published?: boolean; show_join?: boolean };
  const slug = (b.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  switch (b._action) {
    case "save":
      if (!slug) return json({ error: "slug（英数字）が必要" }, 400);
      if (!b.title) return json({ error: "タイトルが必要" }, 400);
      await upsertSite(env, { slug, title: b.title, body: b.body, published: b.published, show_join: b.show_join });
      return json({ ok: true, slug });
    case "delete":
      if (slug) await deleteSite(env, slug);
      return json({ ok: true });
    default:
      return json({ error: "不明な操作" }, 400);
  }
};
