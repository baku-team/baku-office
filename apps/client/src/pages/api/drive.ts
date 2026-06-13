import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { cachedEntitlement } from "../../lib/client.ts";
import { syncDriveMetadata, setDriveBackup, backupToDrive } from "../../lib/drive.ts";
import { atLeast } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// ドライブ操作（管理者・Plus以上）：メタ同期／バックアップ設定／今すぐバックアップ。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await cachedEntitlement(env), "plus")) return json({ error: "ドライブ連携は Plus 以上で利用できます" }, 403);

  const b = (await request.json().catch(() => ({}))) as { _action?: string; enabled?: boolean };
  switch (b._action) {
    case "sync": return json(await syncDriveMetadata(env));
    case "backup_settings": await setDriveBackup(env, !!b.enabled); return json({ ok: true });
    case "backup_now": return json(await backupToDrive(env, 10));
    default: return json({ error: "不明な操作" }, 400);
  }
};
