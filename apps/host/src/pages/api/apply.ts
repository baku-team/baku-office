import type { APIRoute } from "astro";
import { nowSec, randomId } from "../../lib/host.ts";
import { initialEntitlement, type Plan } from "@baku-office/shared";

export const prerender = false;

// 申込（§5ホスト側）：団体情報＋プラン → customers/licenses 作成。X は即 free、Y/Z は入金前 free 相当（§2.3）。
// Phase1：Google認証は dev（googleSub 任意）。本番は /api/auth/google でログイン後に呼ぶ。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as {
    orgName?: string;
    contactName?: string;
    contactEmail?: string;
    plan?: Plan;
    googleSub?: string;
  };
  if (!b.orgName || !b.plan || !["X", "Y", "Z"].includes(b.plan)) {
    return json({ error: "orgName と plan(X/Y/Z) が必要" }, 400);
  }
  const now = nowSec();
  const customerId = randomId();
  const licenseId = randomId();
  await env.DB.prepare("INSERT INTO customers (id, org_name, contact_name, contact_email, created_at) VALUES (?,?,?,?,?)")
    .bind(customerId, b.orgName, b.contactName ?? null, b.contactEmail ?? null, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO licenses (license_id, customer_id, plan, entitlement, status, google_sub, created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(licenseId, customerId, b.plan, initialEntitlement(b.plan), "active", b.googleSub ?? null, now)
    .run();
  return json({ ok: true, licenseId, plan: b.plan, entitlement: initialEntitlement(b.plan) });
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
