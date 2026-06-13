import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { randomId } from "@baku-office/shared";
import { nowSec } from "../../lib/accounting.ts";
import { audit } from "../../lib/storage.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 予定（schedules）と議事録（knowledge tags=議事録）の作成・ソフトデリート。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);
  const b = (await request.json().catch(() => ({}))) as Record<string, string>;

  if (b.kind === "schedule") {
    if (b._action === "delete") { await env.DB.prepare("UPDATE schedules SET deleted_at=? WHERE id=?").bind(nowSec(), b.id).run(); return json({ ok: true }); }
    if (!b.title || !b.start_at) return json({ error: "title と start_at が必要" }, 400);
    const id = randomId();
    await env.DB.prepare("INSERT INTO schedules (id,title,start_at,end_at,body,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(id, b.title, b.start_at, b.end_at ?? null, b.body ?? null, ses.uid, nowSec()).run();
    await audit(env, ses.uid, "schedule.create", id);
    // 任意：Googleカレンダーにも登録（ベストエフォート＝失敗しても内部保存は成立）。終了時刻が無ければ開始+1時間。
    let googlePushed = false, googleError = "";
    if (b.to_google) {
      try {
        const { createEvent } = await import("../../parts/calendar.ts");
        const withSec = (s: string) => (/T\d{2}:\d{2}$/.test(s) ? `${s}:00` : s);
        const start = withSec(b.start_at);
        let end = b.end_at ? withSec(b.end_at) : "";
        if (!end) {
          const d = new Date(`${start}Z`); // naive を UTC とみなし +1h（JST 表記で送るため日跨ぎも安全に算出）。
          if (!Number.isNaN(d.getTime())) {
            d.setUTCHours(d.getUTCHours() + 1);
            const p = (n: number) => String(n).padStart(2, "0");
            end = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
          } else end = start;
        }
        const res = await createEvent(locals.ctx, { title: b.title, start, end, description: b.body });
        googlePushed = res.startsWith("予定を作成しました");
        if (!googlePushed) googleError = res;
      } catch (e) { googleError = (e as Error).message; }
    }
    return json({ ok: true, id, googlePushed, googleError });
  }
  if (b.kind === "minutes") {
    if (b._action === "delete") { await env.DB.prepare("UPDATE knowledge SET deleted_at=? WHERE id=?").bind(nowSec(), b.id).run(); return json({ ok: true }); }
    if (!b.title) return json({ error: "title が必要" }, 400);
    const id = randomId();
    await env.DB.prepare("INSERT INTO knowledge (id,title,body,file_ref,tags,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(id, b.title, b.body ?? "", null, "議事録", ses.uid, nowSec()).run();
    await audit(env, ses.uid, "minutes.create", id);
    return json({ ok: true, id });
  }
  return json({ error: "kind が不正" }, 400);
};
