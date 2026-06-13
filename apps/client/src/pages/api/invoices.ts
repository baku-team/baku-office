import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { cachedEntitlement } from "../../lib/client.ts";
import { atLeast } from "@baku-office/shared";
import { saveFile } from "../../lib/storage.ts";
import { registerInvoiceFromFile, setInvoiceStatus } from "../../parts/invoices.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 請求書の手動アップロード（multipart）＋ステータス更新（JSON）。Pro以上・管理者・org のみ。
export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = locals.ctx;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await cachedEntitlement(env), "pro")) return json({ error: "請求書管理は Pro 以上のプランで利用できます" }, 403);

  const ct = request.headers.get("content-type") ?? "";
  // 手動アップロード：ファイル保存→Claude抽出→invoices登録。
  if (ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    const file = fd.get("file");
    if (!(file instanceof File)) return json({ error: "ファイルが必要です" }, 400);
    const saved = await saveFile(env, file, ses.uid, ses.ctx);
    const r = await registerInvoiceFromFile(ctx, ses.uid, saved.id, "manual");
    if (r.error) return json({ error: r.error }, 400);
    return json({ ok: true, ...r });
  }
  // ステータス更新。
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; status?: string };
  if (b._action === "status") {
    if (!b.id || !b.status) return json({ error: "id・status が必要" }, 400);
    const r = await setInvoiceStatus(ctx, b.id, b.status);
    return r.ok ? json({ ok: true }) : json({ error: r.error }, 400);
  }
  return json({ error: "不明な操作" }, 400);
};
