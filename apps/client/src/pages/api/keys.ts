import type { APIRoute } from "astro";
import { saveApiKey, hasApiKey, validateApiKey } from "../../lib/client.ts";

export const prerender = false;

const FIELDS = ["gemini", "line_secret", "line_token", "claude", "notion", "google_client_id", "google_client_secret"] as const;
type Field = (typeof FIELDS)[number];

// GET：各キーの設定状態（マスク。値は返さない）。
export const GET: APIRoute = async ({ locals }) => {
  const env = locals.runtime.env;
  const status: Record<string, boolean> = {};
  for (const f of FIELDS) status[f] = await hasApiKey(env, f);
  return json({ status });
};

// POST：保存時バリデーション → AES-GCM 暗号化して KV 保存（§7.2/10.3）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as Partial<Record<Field, string>>;
  const result: Record<string, { ok: boolean; detail?: string }> = {};
  for (const f of FIELDS) {
    const v = b[f];
    if (v === undefined || v === "") continue; // 空欄は変更なし
    const val = await validateApiKey(f, v);
    result[f] = val;
    if (val.ok) await saveApiKey(env, f, v);
  }
  return json({ ok: true, result });
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
