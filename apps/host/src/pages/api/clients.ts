import type { APIRoute } from "astro";
import { getHostSession } from "../../lib/hostauth.ts";
import { recordAudit } from "../../lib/host.ts";
import { deleteRepo } from "@baku-office/shared";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// クライアント管理（管理者のみ）：プラン／エンタイトルメント／ステータスを手動変更（§13・運用）。
// エンタイトルメントは次回の統合チェックでクライアントに反映、status=suspended で機能停止（データは保持）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getHostSession(env, request);
  if (!ses?.isAdmin) return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; license_id?: string; plan?: string; entitlement?: string; status?: string };
  if (!b.license_id) return json({ error: "license_id が必要" }, 400);

  // 削除（アクティベート解除）：ライセンス・アクティベーションコード・（他に紐づくライセンスが無ければ）顧客を削除。
  // クライアント側の既存トークンは次回の統合チェックでライセンス無し＝無料(Free)相当に落ち、有料機能が停止する。再開は再申込。
  if (b._action === "delete") {
    const row = await env.DB.prepare("SELECT customer_id FROM licenses WHERE license_id = ?").bind(b.license_id).first<{ customer_id: string }>();
    await env.DB.prepare("DELETE FROM licenses WHERE license_id = ?").bind(b.license_id).run();
    await env.DB.prepare("DELETE FROM activation_codes WHERE license_id = ?").bind(b.license_id).run();
    // 関連レコードの孤児化を防ぐ（D1 に FK/CASCADE が無いため明示削除）。a2a_audit は監査履歴として残す。
    await env.DB.prepare("DELETE FROM app_usage WHERE license_id = ?").bind(b.license_id).run();
    await env.DB.prepare("DELETE FROM app_downloads WHERE license_id = ?").bind(b.license_id).run();
    await env.DB.prepare("DELETE FROM app_reviews WHERE license_id = ?").bind(b.license_id).run();
    await env.DB.prepare("DELETE FROM nonprofit_applications WHERE license_id = ?").bind(b.license_id).run();
    await env.DB.prepare("DELETE FROM a2a_group_members WHERE member_license = ?").bind(b.license_id).run();
    await env.DB.prepare("DELETE FROM a2a_groups WHERE owner_license = ?").bind(b.license_id).run();
    await env.DB.prepare("DELETE FROM a2a_connections WHERE org_a_license = ? OR org_b_license = ?").bind(b.license_id, b.license_id).run();
    if (row?.customer_id) {
      const other = await env.DB.prepare("SELECT 1 FROM licenses WHERE customer_id = ? LIMIT 1").bind(row.customer_id).first();
      if (!other) await env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(row.customer_id).run();
    }
    // throwaway リポを削除（§2.3・best-effort）。クライアントのCF内データには触れない。
    if (env.GITHUB_TOKEN && env.GITHUB_OWNER) {
      try { await deleteRepo({ token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER }, b.license_id); } catch { /* best-effort */ }
    }
    await recordAudit(env, ses.email, "client.delete", b.license_id, null);
    return json({ ok: true });
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.plan && ["free", "plus", "pro", "nonprofit"].includes(b.plan)) { sets.push("plan = ?"); binds.push(b.plan); }
  if (b.entitlement && ["free", "plus", "pro", "nonprofit", "enterprise", "test"].includes(b.entitlement)) { sets.push("entitlement = ?"); binds.push(b.entitlement); }
  if (b.status && ["active", "suspended"].includes(b.status)) { sets.push("status = ?"); binds.push(b.status); }
  if (!sets.length) return json({ error: "変更項目がありません（plan/entitlement/status）" }, 400);

  binds.push(b.license_id);
  await env.DB.prepare(`UPDATE licenses SET ${sets.join(", ")} WHERE license_id = ?`).bind(...binds).run();
  await recordAudit(env, ses.email, "client.update", b.license_id, sets.join(", "));
  return json({ ok: true });
};
