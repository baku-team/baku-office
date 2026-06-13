import type { APIRoute } from "astro";
import { nowSec, signingJwk } from "../../lib/host.ts";
import { recordReport } from "../../lib/reports.ts";
import { openLicense, type Envelope } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// クライアント→ホストの報告受信（自動エラー・不具合/要望）。認証＝ライセンストークン（なりすまし防止）。
// PII を載せない方針：本文/コンテキストは要約・スタック等に限る（クライアント側で配慮）。
export const POST: APIRoute = async ({ request, locals }) => {
  const b = (await request.json().catch(() => ({}))) as {
    token?: string; kind?: string; severity?: string; category?: string;
    title?: string; message?: string; context?: string; appVersion?: string; fingerprint?: string;
    reports?: Array<{ kind?: string; severity?: string; category?: string; title?: string; message?: string; context?: string; appVersion?: string; fingerprint?: string }>;
  };
  if (!b.token) return json({ error: "token が必要" }, 400);
  let payload: { licenseId: string } | null = null;
  try {
    const envlp = JSON.parse(atob(b.token)) as Envelope;
    payload = await openLicense(signingJwk(env), envlp, nowSec());
  } catch { /* 不正トークン */ }
  if (!payload) return json({ error: "token 無効または失効" }, 401);

  // 単発／バッチ（reports[]）どちらも受ける。
  const items = b.reports && Array.isArray(b.reports) ? b.reports : [b];
  const ids: string[] = [];
  for (const it of items.slice(0, 50)) {
    const kind = it.kind === "request" ? "request" : "error";
    if (!it.message) continue;
    const r = await recordReport(env, {
      licenseId: payload.licenseId, kind,
      severity: it.severity ?? null, category: it.category ?? null,
      title: it.title ?? null, message: String(it.message), context: it.context ?? null,
      appVersion: it.appVersion ?? null, fingerprint: it.fingerprint ?? null,
    }).catch(() => null);
    if (r) ids.push(r.id);
  }
  return json({ ok: true, received: ids.length });
};
