import type { APIRoute } from "astro";
import { saveApiKey, hasApiKey, validateApiKey } from "../../lib/client.ts";
import { requireOrgAdmin } from "../../lib/auth.ts";
import { env } from "cloudflare:workers";

export const prerender = false;

const FIELDS = ["gemini", "line_secret", "line_token", "claude", "notion", "google_client_id", "google_client_secret"] as const;
type Field = (typeof FIELDS)[number];

// APIキーは組織共通の機密＝admin+org のみ（settings.ts と同基準）。
// WHY: 未認証だと第三者がキーを上書き（攻撃者キー注入でAI通信を窃取／clobberでDoS）できた。

// GET：各キーの設定状態（マスク。値は返さない）。
export const GET: APIRoute = async ({ request, locals }) => {
  if (!(await requireOrgAdmin(env, request))) return json({ error: "管理者のみ" }, 403);
  const status: Record<string, boolean> = {};
  for (const f of FIELDS) status[f] = await hasApiKey(env, f);
  return json({ status });
};

// POST：保存時バリデーション → AES-GCM 暗号化して KV 保存（§7.2/10.3）。
export const POST: APIRoute = async ({ request, locals }) => {
  if (!(await requireOrgAdmin(env, request))) return json({ error: "管理者のみ" }, 403);
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
